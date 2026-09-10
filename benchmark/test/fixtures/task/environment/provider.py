import hashlib
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = bytearray()
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                size = int(self.rfile.readline().split(b";", 1)[0], 16)
                if not size:
                    while self.rfile.readline().strip():
                        pass
                    break
                body.extend(self.rfile.read(size))
                self.rfile.read(2)
        else:
            body.extend(self.rfile.read(int(self.headers["Content-Length"])))
        request = json.loads(body)
        if (
            hashlib.sha256(self.headers.get("Authorization", "").encode()).hexdigest()
            != "b08bd1721320be8feb3c7003bee8b933b0222c4a8f0ef589a6a1e9ce6d549c77"
        ):
            self.send_error(401)
            return
        if self.path.endswith("/embeddings"):
            data = json.dumps(
                {
                    "object": "list",
                    "data": [{"object": "embedding", "index": 0, "embedding": [1.0] + [0.0] * 383}],
                    "model": "fixture-embedding",
                    "usage": {"prompt_tokens": 1, "total_tokens": 1},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        mode = request.get("model", "fixture")
        if request.get("stream") and mode in {"hang", "disconnect"}:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            if mode == "disconnect":
                self.send_header("Content-Length", "1048576")
            self.end_headers()
            frame = {
                "id": "partial",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": mode,
                "choices": [
                    {"index": 0, "delta": {"role": "assistant", "content": "Retained prefix"}, "finish_reason": None}
                ],
            }
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
            self.wfile.flush()
            Path("/logs/artifacts/provider-started").write_text(mode)
            if mode == "disconnect":
                self.close_connection = True
                return
            try:
                while True:
                    self.wfile.write(b":" + b"x" * 1024 + b"\n\n")
                    self.wfile.flush()
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError):
                return
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
            if mode == "long":
                data = (b":" + b"x" * 1021 + b"\n\n") * (30 * 1024) + data
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
