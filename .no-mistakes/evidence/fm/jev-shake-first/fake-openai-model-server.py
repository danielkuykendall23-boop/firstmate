import json, sys, time, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[2]
WINDOW = int(os.environ.get("WIN", "64000"))
NCALLS = int(os.environ.get("NCALLS", "4"))
LINES = int(os.environ.get("LINES","500"))
MODE = os.environ.get("MODE", "tools")  # tools | prose
n = [0]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
        self.wfile.write(json.dumps({"data":[{"id":"fake-1","object":"model"}]}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        msgs = body.get("messages", [])
        n[0] += 1
        est = len(json.dumps(msgs)) // 4
        ncall = sum(len(m.get("tool_calls") or []) for m in msgs if m.get("role") == "assistant")
        last = msgs[-1] if msgs else {}
        lastc = last.get("content")
        lasttext = lastc if isinstance(lastc, str) else json.dumps(lastc)
        # what to do
        reply = None; tool = None; usage = est
        tools = [t["function"]["name"] for t in body.get("tools", [])]
        sysmsg = json.dumps([m for m in msgs if m.get("role") in ("system","developer")])[:3000]
        is_summary = ("Summarize" in sysmsg) or ("handoff document" in lasttext) or ("summar" in lasttext.lower()[:2000] and last.get("role")=="user" and ncall==0 and len(msgs)<=3 and "conversation>" in lasttext)
        if is_summary:
            reply = "## Goal\nMOCK-SUMMARY: generator runs.\n## Next Steps\n1. Report."
        elif "READ_ARTIFACT" in os.environ and last.get("role") == "user" and "recover" in lasttext:
            tool = ("read", {"path": os.environ["READ_ARTIFACT"]})
        elif MODE == "tools" and last.get("role") in ("user","tool") and ncall < NCALLS :
            k = ncall + 1
            tool = ("bash", {"command": f"for i in $(seq 1 {LINES}); do echo \"call{k} line $i marker-UNIQUE-{k}-$i padding padding padding\"; done"})
        elif MODE == "prose" and last.get("role") == "user" and ncall == 0 and "summar" not in lasttext.lower():
            reply = ("This is long prose. " * int(os.environ.get("REPS","6000")))
            usage = int(WINDOW * 0.95)
        else:
            reply = "done after tools: " + lasttext[:300]
            usage = int(os.environ.get("FINAL_USAGE", usage))
        rec = {"n": n[0], "nmsgs": len(msgs), "ncall": ncall, "last_role": last.get("role"), "est": est, "tools": tools[:40], "tool": tool, "reply": (reply or "")[:120], "usage": usage, "last_snip": lasttext[:400]}
        with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
        with open(LOG + f".req{n[0]}.json", "w") as f: json.dump(body, f)
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        def send(o): self.wfile.write(("data: " + json.dumps(o) + "\n\n").encode()); self.wfile.flush()
        base = {"id":"c1","object":"chat.completion.chunk","created":int(time.time()),"model":"fake-1"}
        if tool:
            send({**base, "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":f"call_{n[0]}","type":"function","function":{"name":tool[0],"arguments":json.dumps(tool[1])}}]},"finish_reason":None}]})
            send({**base, "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
        else:
            send({**base, "choices":[{"index":0,"delta":{"role":"assistant","content":reply},"finish_reason":None}]})
            send({**base, "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
        send({**base, "choices":[], "usage":{"prompt_tokens":usage,"completion_tokens":20,"total_tokens":usage+20}})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
