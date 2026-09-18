#!/usr/bin/env python3
"""Drive a real omp TUI inside a pseudo-terminal and snapshot the screen.

Usage: uv run --with pyte python omp-tui-driver.py <script.json> <outdir> -- <omp args...>

The script is a JSON list of steps:
  {"wait": "<regex>", "timeout": 60}   wait until the rendered screen matches
  {"type": "text"}                     type literal text
  {"key": "enter|escape|ctrl-c|ctrl-d|up|down|tab"}
  {"sleep": 2.5}
  {"snap": "name"}                     write <outdir>/<name>.txt and .html
  {"shell": "command"}                 run a shell command (e.g. rewrite the preference file)
  {"expect": "<regex>"}                fail unless the current screen matches

Every byte omp writes is also appended to <outdir>/raw.bin so the run can be replayed.
"""
import fcntl
import html
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

COLS, ROWS = 110, 34

NAMED = {
    "default": None, "black": "#1c1c1c", "red": "#ff5f5f", "green": "#5fd75f", "brown": "#d7af5f",
    "blue": "#5f87ff", "magenta": "#d787d7", "cyan": "#5fd7d7", "white": "#dadada",
    "brightblack": "#767676", "brightred": "#ff8787", "brightgreen": "#87ff87", "brightbrown": "#ffd787",
    "brightblue": "#87afff", "brightmagenta": "#ff87ff", "brightcyan": "#87ffff", "brightwhite": "#ffffff",
}


def css_color(value, default):
    if value in (None, "default"):
        return default
    if value in NAMED:
        return NAMED[value] or default
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return "#" + value
    return default


def render_html(screen, title):
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        cells = []
        for x in range(screen.columns):
            ch = line[x]
            fg = css_color(ch.fg, "#d0d0d0")
            bg = css_color(ch.bg, None)
            if ch.reverse:
                fg, bg = (bg or "#0d0d0d"), (fg or "#d0d0d0")
            style = f"color:{fg};"
            if bg:
                style += f"background:{bg};"
            if ch.bold:
                style += "font-weight:bold;"
            if ch.italics:
                style += "font-style:italic;"
            if ch.underscore:
                style += "text-decoration:underline;"
            text = html.escape(ch.data if ch.data else " ")
            cells.append(f'<span style="{style}">{text}</span>')
        rows.append("".join(cells))
    body = "\n".join(rows)
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>body{{margin:0;background:#0d0d0d;}}pre{{margin:0;padding:12px;font:15px/1.25 "JetBrains Mono","Menlo","DejaVu Sans Mono",monospace;background:#0d0d0d;color:#d0d0d0;white-space:pre;}}
.cap{{font:13px sans-serif;color:#9a9a9a;padding:8px 12px 0 12px;background:#0d0d0d;}}</style></head>
<body><div class="cap">{html.escape(title)}</div><pre>{body}</pre></body></html>"""


def main():
    argv = sys.argv[1:]
    script_path, outdir = argv[0], argv[1]
    assert argv[2] == "--"
    cmd = argv[3:]
    os.makedirs(outdir, exist_ok=True)
    steps = json.load(open(script_path))
    raw = open(os.path.join(outdir, "raw.bin"), "wb")
    log = open(os.path.join(outdir, "driver.log"), "w")

    def note(msg):
        stamp = time.strftime("%H:%M:%S")
        log.write(f"[{stamp}] {msg}\n")
        log.flush()
        print(f"[{stamp}] {msg}", flush=True)

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["LINES"] = str(ROWS)
        os.environ["COLUMNS"] = str(COLS)
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    pending = b""

    def pump(duration):
        nonlocal pending
        end = time.time() + duration
        while True:
            remaining = end - time.time()
            if remaining <= 0:
                return
            r, _, _ = select.select([fd], [], [], min(remaining, 0.05))
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            raw.write(data)
            raw.flush()
            pending += data
            # Answer the terminal queries a real emulator would answer.
            replies = b""
            for m in re.finditer(rb"\x1b\[6n", pending):
                replies += f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R".encode()
            if b"\x1b[c" in pending or b"\x1b[0c" in pending:
                replies += b"\x1b[?62;22c"
            for m in re.finditer(rb"\x1b\](1[01]);\?(\x07|\x1b\\)", pending):
                which = m.group(1).decode()
                rgb = "rgb:d0d0/d0d0/d0d0" if which == "10" else "rgb:0d0d/0d0d/0d0d"
                replies += f"\x1b]{which};{rgb}\x07".encode()
            if replies:
                os.write(fd, replies)
            stream.feed(pending)
            pending = b""

    def text():
        return "\n".join(screen.display)

    def snap(name):
        pump(0.3)
        body = text()
        with open(os.path.join(outdir, f"{name}.txt"), "w") as f:
            f.write(body + "\n")
        with open(os.path.join(outdir, f"{name}.html"), "w") as f:
            f.write(render_html(screen, f"omp {name}"))
        note(f"snapshot {name}")

    def send(data: bytes):
        os.write(fd, data)

    KEYS = {"enter": b"\r", "escape": b"\x1b", "ctrl-c": b"\x03", "ctrl-d": b"\x04", "up": b"\x1b[A",
            "down": b"\x1b[B", "tab": b"\t", "left": b"\x1b[D", "right": b"\x1b[C", "backspace": b"\x7f"}

    ok = True
    try:
        pump(0.5)
        for step in list(steps) if False else steps:
            if "wait" in step:
                pat = re.compile(step["wait"], re.S)
                deadline = time.time() + step.get("timeout", 60)
                note(f"wait /{step['wait']}/")
                while not pat.search(text()):
                    if time.time() > deadline:
                        snap("timeout-" + re.sub(r"[^A-Za-z0-9]+", "-", step["wait"])[:40])
                        raise TimeoutError(f"screen never matched {step['wait']!r}")
                    pump(0.2)
                pump(0.3)
            elif "type" in step:
                note(f"type {step['type']!r}")
                for chunk in step["type"]:
                    send(chunk.encode())
                    pump(0.02)
                pump(0.3)
            elif "key" in step:
                note(f"key {step['key']}")
                send(KEYS[step["key"]])
                pump(0.5)
            elif "sleep" in step:
                note(f"sleep {step['sleep']}")
                pump(step["sleep"])
            elif "snap" in step:
                snap(step["snap"])
            elif "shell" in step:
                note(f"shell {step['shell']}")
                subprocess.run(step["shell"], shell=True, check=True)
            elif "if" in step:
                if re.search(step["if"], text(), re.S):
                    note(f"if /{step['if']}/ matched")
                    steps[steps.index(step) + 1:steps.index(step) + 1] = step["then"]
                else:
                    note(f"if /{step['if']}/ not matched")
            elif "expect" in step:
                if not re.search(step["expect"], text(), re.S):
                    snap("unexpected")
                    raise AssertionError(f"screen did not match {step['expect']!r}")
                note(f"expect ok /{step['expect']}/")
    except Exception as exc:  # noqa: BLE001
        ok = False
        note(f"FAILED: {exc}")
    finally:
        pump(1.0)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        pump(1.0)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        raw.close()
        log.close()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
