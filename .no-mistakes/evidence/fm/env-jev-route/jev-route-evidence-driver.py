#!/usr/bin/env python3
"""Evidence driver for task-bound Jev routing in the OMP primary.

Runs the real omp binary and the real bin/fm-dispatch-resolve.sh against loopback
fake Jev / chat / quota endpoints (no credentials, no vendor calls). Produces:
  * RPC frame transcripts (JSON lines) plus condensed human-readable transcripts
  * interactive terminal (TUI) screen renders as text and HTML at key moments
  * the routing metadata log written by the extension
  * integrity checks that saved model defaults (isolated and real global) did not change
Usage: jev-route-evidence-driver.py <worktree-root> <evidence-dir>
"""
import fcntl
import hashlib
import html
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, "/tmp/fm-jev-evidence-pydeps")
import pyte  # noqa: E402

ROOT = os.path.abspath(sys.argv[1])
EV = os.path.abspath(sys.argv[2])
LAB = tempfile.mkdtemp(prefix="fm-jev-route-evidence-")
REAL_CURL = shutil.which("curl")
VERSION = subprocess.check_output(["omp", "--version"], text=True).strip()
GLOBAL_CONFIG = os.path.expanduser("~/.omp/agent/config.yml")


def meta(path):
    try:
        st = os.stat(path)
        return {"mtime": st.st_mtime, "size": st.st_size}
    except FileNotFoundError:
        return None


GLOBAL_BEFORE = meta(GLOBAL_CONFIG)

# ---------------------------------------------------------------- loopback endpoints
lock = threading.Lock()
state = {"jev": 0, "chat": 0, "chat_models": [], "todo_issued": False, "jev_requests": []}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/v1/systemone":
            with lock:
                state["jev"] += 1
                state["jev_requests"].append({
                    "authorization": "Bearer [synthetic]" if self.headers.get("authorization") == "Bearer fake" else self.headers.get("authorization"),
                    "question_keys": list((data.get("questions") or {}).keys()),
                    "state": data.get("state"),
                })
            body = json.dumps({"model": "jev-fake", "answers": {"rule": {"choice": "rule_1", "confidence": 0.95,
                               "probabilities": {"rule_1": 0.95, "default": 0.05}}}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        assert self.path == "/v1/chat/completions", self.path
        with lock:
            state["chat"] += 1
            n = state["chat"]
            state["chat_models"].append(data.get("model"))
            first = not state["todo_issued"]
            state["todo_issued"] = True
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def chunk(delta, finish=None):
            payload = {"id": f"chat-{n}", "object": "chat.completion.chunk", "created": 1, "model": data.get("model"),
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        if first:
            chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "todo-smoke", "type": "function", "function": {
                "name": "todo", "arguments": json.dumps({"op": "init", "items": ["Prove routing through the real runtime"]})}}]})
            chunk({}, "tool_calls")
        else:
            chunk({"role": "assistant", "content": "ROUTE_SMOKE_OK"})
            chunk({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}"


def counters():
    with lock:
        return {"jev": state["jev"], "chat": state["chat"], "chat_models": list(state["chat_models"])}


# ---------------------------------------------------------------- fake Firstmate home
def prepare(name, keyed, protected=False, discover=False):
    home = os.path.join(LAB, name)
    agent = os.path.join(home, "agent")
    fakebin = os.path.join(home, "fakebin")
    for d in (agent, fakebin, os.path.join(home, "config"), os.path.join(home, "user")):
        os.makedirs(d, exist_ok=True)
    config = "modelRoles:\n  default: route-fake/initial\ndefaultThinkingLevel: low\n" + ("secrets:\n  enabled: true\n" if protected else "")
    config_path = os.path.join(agent, "config.yml")
    with open(config_path, "w") as f:
        f.write(config)
    before = os.stat(config_path)
    if keyed:
        with open(os.path.join(home, ".env"), "w") as f:
            f.write("TYPESAFE_API_KEY=fake\n")
        os.chmod(os.path.join(home, ".env"), 0o600)
    with open(os.path.join(home, "config", "crew-dispatch.json"), "w") as f:
        json.dump({"rules": [{"when": "Complete this task reliably.",
                              "use": {"harness": "omp", "model": "route-fake/routed", "effort": "high", "provider": "codex"}}]}, f)
    # Keep the production endpoint fixed in the resolver; this test-only transport redirects it to loopback.
    with open(os.path.join(fakebin, "curl"), "w") as f:
        f.write("#!/usr/bin/env bash\nargs=()\nfor arg in \"$@\"; do\n  case \"$arg\" in https://api.typesafe.ai/v1/systemone) "
                f"args+=('{BASE}/v1/systemone') ;; *) args+=(\"$arg\") ;; esac\ndone\nexec '{REAL_CURL}' \"${{args[@]}}\"\n")
    with open(os.path.join(fakebin, "quota-axi"), "w") as f:
        f.write("#!/usr/bin/env bash\nprintf '%s\\n' '{\"schemaVersion\":5,\"providers\":[{\"provider\":\"codex\",\"quotaSemantics\":{\"status\":\"known\","
                "\"effectiveAvailability\":[{\"scope\":\"all_models\",\"status\":\"known\",\"effectivePercentRemaining\":80,"
                "\"runway\":{\"status\":\"through_reset\"},\"selection\":{\"spendPriority\":0.8}}]}}]}'\n")
    os.chmod(os.path.join(fakebin, "curl"), 0o700)
    os.chmod(os.path.join(fakebin, "quota-axi"), 0o700)
    with open(os.path.join(home, "provider.mjs"), "w") as f:
        f.write('export default function(pi) { pi.registerProvider("route-fake", { baseUrl: "%s/v1", apiKey: "fake", api: "openai-completions", '
                'models: ["initial","routed","manual"].map(id => ({id,name:id,reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},'
                'contextWindow:128000,maxTokens:1024})) }); }' % BASE)
    env = dict(os.environ)
    env.update({"HOME": os.path.join(home, "user"), "PI_CODING_AGENT_DIR": agent, "OMP_SKIP_SETUP": "1", "FM_HOME": home,
                "PATH": f"{fakebin}:{os.environ['PATH']}"})
    for key in ["FM_TASK_ID", "FM_ROOT_OVERRIDE", "FM_STATE_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_JEV_ROUTE", "TYPESAFE_API_KEY",
                "OMP_PROFILE", "PI_MODEL", "PI_PLAN_MODEL", "PI_SMOL_MODEL", "PI_SLOW_MODEL"]:
        env.pop(key, None)
    args = ["--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk", "--auto-approve",
            "--tools", "todo", "--max-time", "60", "-e", os.path.join(home, "provider.mjs")]
    if discover:
        # A Firstmate home is a checkout of this repo: omp auto-discovers <cwd>/.omp/extensions with no -e flag.
        os.makedirs(os.path.join(home, ".omp", "extensions"))
        os.makedirs(os.path.join(home, ".pi", "extensions", "lib"))
        shutil.copy(os.path.join(ROOT, ".omp", "extensions", "fm-jev-route.ts"), os.path.join(home, ".omp", "extensions"))
        shutil.copy(os.path.join(ROOT, ".pi", "extensions", "lib", "fm-async-exec.ts"), os.path.join(home, ".pi", "extensions", "lib"))
        shutil.copytree(os.path.join(ROOT, "bin"), os.path.join(home, "bin"))
        shape = "auto-discovered from <home>/.omp/extensions (no -e)"
    else:
        args = ["--no-extensions"] + args + ["-e", os.path.join(ROOT, ".omp", "extensions", "fm-jev-route.ts")]
        shape = "explicit -e .omp/extensions/fm-jev-route.ts"
    with lock:
        state["todo_issued"] = False
    return {"name": name, "home": home, "agent": agent, "config": config, "config_path": config_path, "before": before,
            "env": env, "args": args, "shape": shape}


def logs(home):
    path = os.path.join(home, "state", ".jev-route.log")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f.read().strip().split("\n") if line]


def config_unchanged(p):
    with open(p["config_path"]) as f:
        same_bytes = f.read() == p["config"]
    st = os.stat(p["config_path"])
    return {"bytes_unchanged": same_bytes, "mtime_unchanged": st.st_mtime == p["before"].st_mtime,
            "sha256": hashlib.sha256(p["config"].encode()).hexdigest()}


# ---------------------------------------------------------------- RPC session
class Rpc:
    def __init__(self, p):
        self.p = p
        self.proc = subprocess.Popen(["omp", "--mode", "rpc", *p["args"]], cwd=p["home"], env=p["env"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, encoding="utf-8", errors="replace")
        self.frames = []
        self.cv = threading.Condition()
        self.exited = False
        self.stderr = []
        self.n = 0
        self.transcript = []
        threading.Thread(target=self._stdout, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stdout(self):
        for line in self.proc.stdout:
            try:
                frame = json.loads(line)
            except ValueError:
                frame = {"type": "non-protocol-output", "line": line.rstrip("\n")}
            with self.cv:
                self.frames.append(frame)
                self.cv.notify_all()
        self.proc.wait()
        with self.cv:
            self.exited = True
            self.cv.notify_all()

    def _stderr(self):
        for line in self.proc.stderr:
            self.stderr.append(line.replace("Bearer fake", "Bearer [synthetic]"))

    def wait(self, pred, what, start=0, limit=90):
        deadline = time.time() + limit
        with self.cv:
            while True:
                for i in range(start, len(self.frames)):
                    if pred(self.frames[i]):
                        return i, self.frames[i]
                if self.exited:
                    raise RuntimeError(f"{VERSION} exited before {what}: {''.join(self.stderr)}")
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError(what)
                self.cv.wait(min(remaining, 1.0))

    def request(self, command):
        self.n += 1
        rid = f"{self.p['name']}-{self.n}"
        msg = {**command, "id": rid}
        self.transcript.append(f">> {json.dumps(msg)}")
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        _, resp = self.wait(lambda f: f.get("type") == "response" and f.get("id") == rid, f"response {rid}")
        assert resp.get("success") is True, json.dumps(resp)
        if command["type"] == "prompt" and command["message"].startswith("/"):
            _, result = self.wait(lambda f: f.get("type") == "prompt_result" and f.get("id") == rid, f"prompt_result {rid}")
            assert result.get("agentInvoked") is False, json.dumps(result)
        return resp.get("data")

    def prompt(self, message):
        start = len(self.frames)
        self.request({"type": "prompt", "message": message})
        self.wait(lambda f: f.get("type") == "agent_end", "agent_end", start=start)

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def summarize_frame(frame):
    t = frame.get("type")
    parts = [t]
    for key in ("id", "success", "agentInvoked"):
        if key in frame:
            parts.append(f"{key}={frame[key]}")
    data = frame.get("data") if isinstance(frame.get("data"), dict) else None
    if data:
        model = data.get("model")
        if isinstance(model, dict) and "id" in model:
            parts.append(f"model={model.get('provider')}/{model.get('id')}")
        if "thinkingLevel" in data:
            parts.append(f"thinkingLevel={data['thinkingLevel']}")
    if t in ("available_commands_update",):
        names = [c.get("name") for c in frame.get("commands", []) if isinstance(c, dict)]
        parts.append("jev-route registered" if "jev-route" in names else f"commands={names}")
    raw = json.dumps(frame)
    if "Jev route" in raw or t in ("extension_error", "non-protocol-output"):
        parts.append(raw[:600])
    return "<< " + " ".join(str(x) for x in parts)


def rpc_session(name, keyed, protected=False):
    p = prepare(name, keyed, protected)
    label = "secret protection on" if protected else ("fake Jev endpoint (keyed)" if keyed else "no key")
    rpc = Rpc(p)
    result = {"name": name, "label": label, "shape": p["shape"], "version": VERSION}
    try:
        rpc.wait(lambda f: f.get("type") == "ready", "ready")
        rpc.wait(lambda f: f.get("type") == "available_commands_update" and any(
            isinstance(c, dict) and c.get("name") == "jev-route" for c in f.get("commands", [])), "jev-route registration")
        jev0 = counters()["jev"]
        initial = rpc.request({"type": "get_state"})
        result["initial"] = {"model": f"{initial['model']['provider']}/{initial['model']['id']}", "thinkingLevel": initial["thinkingLevel"]}
        rpc.prompt("Complete the routing smoke task using todo, then answer ROUTE_SMOKE_OK.")
        current = rpc.request({"type": "get_state"})
        result["after_first_prompt"] = {"model": f"{current['model']['provider']}/{current['model']['id']}", "thinkingLevel": current["thinkingLevel"]}
        first_logs = logs(p["home"])
        result["routing_log_after_first_prompt"] = first_logs
        rpc.prompt("Continue the same task; answer ROUTE_SMOKE_OK without tools.")
        result["routing_log_rows_after_routine_turn"] = len(logs(p["home"]))
        rpc.request({"type": "set_model", "provider": "route-fake", "modelId": "manual"})
        rpc.request({"type": "set_thinking_level", "level": "low"})
        rpc.request({"type": "prompt", "message": "/jev-route Explicit selection must win"})
        manual = rpc.request({"type": "get_state"})
        result["after_manual_selection_and_jev_route_command"] = {"model": f"{manual['model']['provider']}/{manual['model']['id']}",
                                                                   "thinkingLevel": manual["thinkingLevel"]}
        result["routing_log_final"] = logs(p["home"])
        result["jev_requests_this_session"] = counters()["jev"] - jev0
        result["saved_agent_config"] = config_unchanged(p)
        result["extension_errors"] = [f for f in rpc.frames if f.get("type") == "extension_error"]
        result["notices"] = [f for f in rpc.frames if "Jev route" in json.dumps(f)]
    finally:
        rpc.close()
        with open(os.path.join(EV, f"rpc-{name}-frames.jsonl"), "w") as f:
            for frame in rpc.frames:
                f.write(json.dumps(frame) + "\n")
        with open(os.path.join(EV, f"rpc-{name}-transcript.txt"), "w") as f:
            f.write(f"# {VERSION} --mode rpc, {label}; extension {p['shape']}\n")
            f.write(f"# launch: omp --mode rpc {' '.join(p['args'])}\n")
            sent = iter(rpc.transcript)
            pending = next(sent, None)
            for frame in rpc.frames:
                # Sends are answered in order; print each send just before its response.
                if frame.get("type") == "response" and pending:
                    f.write(pending + "\n")
                    pending = next(sent, None)
                line = summarize_frame(frame)
                if frame.get("type") not in ("tool_execution_update", "message_update", "agent_start", "turn_start", "turn_end",
                                             "tool_execution_start", "tool_execution_end", "message_start", "message_end"):
                    f.write(line + "\n")
            f.write("# routing log (state/.jev-route.log):\n")
            for row in logs(p["home"]):
                f.write(json.dumps(row) + "\n")
    print(f"ok - {VERSION} rpc {label}: {result['initial']['model']}/{result['initial']['thinkingLevel']} -> "
          f"{result['after_first_prompt']['model']}/{result['after_first_prompt']['thinkingLevel']}; "
          f"manual retained: {result['after_manual_selection_and_jev_route_command']}; jev requests={result['jev_requests_this_session']}")
    return result


# ---------------------------------------------------------------- interactive terminal session
NAMED = {"black": "#000000", "red": "#cd3131", "green": "#0dbc79", "brown": "#e5e510", "blue": "#2472c8", "magenta": "#bc3fbc",
         "cyan": "#11a8cd", "white": "#e5e5e5", "brightblack": "#666666", "brightred": "#f14c4c", "brightgreen": "#23d18b",
         "brightyellow": "#f5f543", "brightblue": "#3b8eea", "brightmagenta": "#d670d6", "brightcyan": "#29b8db", "brightwhite": "#ffffff"}


def color(c, default):
    if c == "default" or c is None:
        return default
    if c in NAMED:
        return NAMED[c]
    if len(c) == 6:
        return "#" + c
    return default


def render_html(screen, title, caption):
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        spans = []
        cur = None
        buf = []
        for x in range(screen.columns):
            ch = line[x]
            fg, bg = color(ch.fg, "#d4d4d4"), color(ch.bg, "transparent")
            if ch.reverse:
                fg, bg = (bg if bg != "transparent" else "#1e1e1e"), fg
            style = (fg, bg, ch.bold, ch.underscore, ch.italics)
            if style != cur:
                if buf:
                    spans.append((cur, "".join(buf)))
                cur, buf = style, []
            buf.append(ch.data if ch.data else " ")
        if buf:
            spans.append((cur, "".join(buf)))
        out = []
        for (fg, bg, bold, ul, it), textv in spans:
            css = f"color:{fg};background:{bg};" + ("font-weight:bold;" if bold else "") + ("text-decoration:underline;" if ul else "") + ("font-style:italic;" if it else "")
            out.append(f'<span style="{css}">{html.escape(textv)}</span>')
        rows.append("".join(out).rstrip())
    body = "\n".join(rows)
    return ("<!doctype html><html><head><meta charset='utf-8'><title>" + html.escape(title) + "</title>"
            "<style>body{background:#1e1e1e;margin:0;padding:14px 18px;font-family:-apple-system,Helvetica,sans-serif;color:#cfcfcf}"
            "h2{font-size:15px;margin:0 0 4px 0;color:#eee}p{font-size:12px;margin:0 0 10px 0;color:#aaa}"
            "pre{font:13px/1.35 Menlo,Monaco,monospace;white-space:pre;margin:0;background:#000;padding:8px;border-radius:6px;display:inline-block;min-width:960px}</style>"
            "</head><body><h2>" + html.escape(title) + "</h2><p>" + html.escape(caption) + "</p><pre>" + body + "</pre></body></html>")


def terminal_session(name, keyed, discover, prompts):
    p = prepare(name, keyed, False, discover)
    label = "fake Jev endpoint (keyed)" if keyed else "no key"
    env = {**p["env"], "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(p["home"])
        os.execvpe("omp", ["omp", *p["args"]], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    screen = pyte.Screen(120, 40)
    stream = pyte.ByteStream(screen)
    raw = bytearray()
    snapshots = []
    alive = {"v": True}
    watchers = []

    def text():
        return "\n".join(screen.display)

    def pump(timeout=0.1):
        r, _, _ = select.select([fd], [], [], timeout)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                alive["v"] = False
                return
            if not data:
                alive["v"] = False
                return
            raw.extend(data)
            stream.feed(data)
        for w in list(watchers):
            if w[1]():
                snap(w[0], w[2])
                watchers.remove(w)

    def snap(label_, caption):
        snapshots.append((label_, text(), render_html(screen, f"{VERSION} interactive terminal - {name}: {label_}", caption)))

    def until(pred, what, limit=90):
        t0 = time.time()
        while not pred():
            if not alive["v"]:
                raise RuntimeError(f"{VERSION} interactive session ended before {what}")
            if time.time() - t0 > limit:
                raise TimeoutError(what)
            pump()

    def settle(seconds):
        t0 = time.time()
        while time.time() - t0 < seconds:
            pump()

    result = {"name": name, "label": label, "shape": p["shape"], "version": VERSION, "launch": f"omp {' '.join(p['args'])} (cwd = fake Firstmate home)"}
    try:
        c0 = counters()
        until(lambda: "initial" in text(), "the footer showed the initial model")
        settle(1.5)
        snap("01-startup", "Before any prompt: the footer shows the saved default route-fake/initial at low effort.")
        watchers.append(("02-jev-route-notice", lambda: "Jev route" in text(),
                         "First moment the extension's notice is visible on screen after the first prompt."))
        os.write(fd, (prompts[0] + "\r").encode())
        if keyed:
            until(lambda: counters()["chat"] >= c0["chat"] + 2 and "ROUTE_SMOKE_OK" in text(), "the reply rendered in the terminal")
        else:
            until(lambda: counters()["chat"] >= c0["chat"] + 2 and "ROUTE_SMOKE_OK" in text(), "the reply rendered in the terminal")
        settle(1.5)
        snap("03-after-first-prompt", "After the first prompt and the todo init plan boundary: footer shows the routed model/effort (keyed) or the retained default (no key).")
        os.write(fd, (prompts[1] + "\r").encode())
        until(lambda: counters()["chat"] >= c0["chat"] + 3 and text().count("ROUTE_SMOKE_OK") >= 2, "the routine turn rendered")
        settle(1.5)
        snap("04-routine-turn", "A routine follow-up turn: no re-route; the selection made at the task start is kept.")
        result["chat_models_used"] = counters()["chat_models"][len(c0["chat_models"]):]
        result["jev_requests_this_session"] = counters()["jev"] - c0["jev"]
        result["routing_log"] = logs(p["home"])
        result["saved_agent_config"] = config_unchanged(p)
        result["notice_seen_on_screen"] = any(s[0] == "02-jev-route-notice" for s in snapshots)
        result["notice_lines"] = sorted({ln.strip() for s in snapshots for ln in s[1].split("\n") if "Jev route" in ln})
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        t0 = time.time()
        while time.time() - t0 < 10:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            pump(0.2)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)
        with open(os.path.join(EV, f"tui-{name}.raw.ansi"), "wb") as f:
            f.write(raw)
        for label_, textv, htmlv in snapshots:
            with open(os.path.join(EV, f"tui-{name}-{label_}.txt"), "w") as f:
                f.write(textv.rstrip() + "\n")
            with open(os.path.join(EV, f"tui-{name}-{label_}.html"), "w") as f:
                f.write(htmlv)
    print(f"ok - {VERSION} interactive tui {label} ({p['shape']}): chat models used={result['chat_models_used']}; "
          f"jev requests={result['jev_requests_this_session']}; notice on screen={result['notice_seen_on_screen']}")
    return result


PROMPTS = ["Complete the routing smoke task using todo, then answer ROUTE_SMOKE_OK.",
           "Continue the same task; answer ROUTE_SMOKE_OK without tools."]
summary = {"omp": VERSION, "worktree": ROOT, "sessions": []}
ok = False
try:
    summary["sessions"].append(rpc_session("keyed", True))
    summary["sessions"].append(rpc_session("nokey", False))
    summary["sessions"].append(rpc_session("protected", True, True))
    summary["sessions"].append(terminal_session("tui-keyed", True, True, PROMPTS))
    summary["sessions"].append(terminal_session("tui-nokey", False, False, PROMPTS))
    summary["fake_jev_requests_total"] = counters()["jev"]
    summary["jev_request_shapes"] = state["jev_requests"]
    summary["real_global_config"] = {"path": GLOBAL_CONFIG, "before": GLOBAL_BEFORE, "after": meta(GLOBAL_CONFIG),
                                     "unchanged": GLOBAL_BEFORE == meta(GLOBAL_CONFIG)}
    ok = True
finally:
    server.shutdown()
    with open(os.path.join(EV, "jev-route-evidence-summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    shutil.rmtree(LAB, ignore_errors=True)
print("ok - evidence complete" if ok else "not ok - see traceback", file=sys.stderr if not ok else sys.stdout)
