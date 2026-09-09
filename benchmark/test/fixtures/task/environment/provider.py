import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        usage = {
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "total_tokens": 110,
            "prompt_tokens_details": {"cached_tokens": 40},
        }
        common = {"id": "fixture", "created": 0, "model": "fixture"}
        tool = bool(request.get("tools")) and not any(message["role"] == "tool" for message in request["messages"])
        delta = {"role": "assistant", "content": "Done"}
        if tool:
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "fixture-call",
                        "type": "function",
                        "function": {
                            "name": "bash",
                            "arguments": json.dumps(
                                {"command": "printf verified > /app/marker", "description": "Write verification marker"}
                            ),
                        },
                    }
                ],
            }
        if request.get("stream"):
            frames = [
                {
                    **common,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                },
                {
                    **common,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}],
                    "usage": usage,
                },
            ]
            data = ("".join("data: " + json.dumps(frame) + "\n\n" for frame in frames) + "data: [DONE]\n\n").encode()
            kind = "text/event-stream"
        else:
            data = json.dumps(
                {
                    **common,
                    "object": "chat.completion",
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": "Done"}, "finish_reason": "stop"}
                    ],
                    "usage": usage,
                }
            ).encode()
            kind = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ThreadingHTTPServer(("127.0.0.1", 8087), Handler).serve_forever()
