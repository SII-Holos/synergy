from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from types import TracebackType
from typing import Any, BinaryIO

import aiohttp
from aiohttp import web

from .bridge import BRIDGE_VERSION, ResponseStream, chat_to_responses, responses_to_chat, tool_catalog
from .config import MODEL_PARAMETERS, ModelProfile
from .storage import atomic_json, digest, read_json


async def stream_lines(content: aiohttp.StreamReader) -> AsyncIterator[bytes]:
    pending = bytearray()
    async for chunk in content.iter_any():
        pending.extend(chunk)
        while (end := pending.find(b"\n")) >= 0:
            yield bytes(pending[: end + 1])
            del pending[: end + 1]
        if len(pending) > 128 * 1024**2:
            raise ValueError("Provider SSE frame exceeds the recorded 128 MiB limit")
    if pending:
        yield bytes(pending)


def read_ledger(root: Path) -> list[dict[str, Any]]:
    records = []
    for path in sorted(root.glob("*/request.json")):
        row = read_json(path)
        request = path.parent / "downstream.json"
        if request.exists():
            row["request_digest"] = digest(read_json(request))
        records.append(row)
    return records


def chat_usage(value: dict[str, Any]) -> dict[str, Any]:
    result = {
        "prompt_tokens": value.get("input_tokens"),
        "completion_tokens": value.get("output_tokens"),
        "total_tokens": value.get("total_tokens"),
    }
    for source, target in [
        ("input_tokens_details", "prompt_tokens_details"),
        ("output_tokens_details", "completion_tokens_details"),
    ]:
        if source in value:
            result[target] = value[source]
    return result


class ChatStream:
    def __init__(self, model: str) -> None:
        self.model = model
        self.identity = "chatcmpl_" + uuid.uuid4().hex
        self.calls: dict[str, int] = {}

    def event(
        self, delta: dict[str, Any], finish: str | None = None, usage: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": self.identity,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if usage is not None:
            value["usage"] = usage
        return value

    def accept(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        kind = event.get("type")
        if kind == "response.output_item.added" and event["item"]["type"] == "function_call":
            item = event["item"]
            index = len(self.calls)
            self.calls[item["id"]] = index
            return [
                self.event(
                    {
                        "tool_calls": [
                            {
                                "index": index,
                                "id": item["call_id"],
                                "type": "function",
                                "function": {"name": item["name"], "arguments": item.get("arguments", "")},
                            }
                        ]
                    }
                )
            ]
        if kind == "response.function_call_arguments.delta":
            return [
                self.event(
                    {"tool_calls": [{"index": self.calls[event["item_id"]], "function": {"arguments": event["delta"]}}]}
                )
            ]
        if kind == "response.output_text.delta":
            return [self.event({"content": event["delta"]})]
        if kind == "response.reasoning_summary_text.delta":
            return [self.event({"reasoning_content": event["delta"]})]
        if kind in {"response.completed", "response.incomplete"}:
            response = event["response"]
            reason = "length" if kind == "response.incomplete" else "tool_calls" if self.calls else "stop"
            return [self.event({}, reason, chat_usage(response["usage"]) if response.get("usage") else None)]
        if kind in {"response.failed", "error"}:
            raise ValueError("Upstream Responses stream failed")
        return []


class Gateway:
    def __init__(
        self,
        model: ModelProfile,
        directory: Path,
        *,
        bind: str = "0.0.0.0",
        advertised: str = "host.docker.internal",
        connect_timeout: float = 30,
        stream_timeout: float | None = None,
    ) -> None:
        self.model = model
        self.directory = directory
        self.bind = bind
        self.advertised = advertised if bind == "0.0.0.0" else bind
        self.token = secrets.token_urlsafe(32)
        self.url = ""
        self.timeout = aiohttp.ClientTimeout(total=None, connect=connect_timeout, sock_read=stream_timeout)
        self.runner: web.AppRunner | None = None
        self.client: aiohttp.ClientSession | None = None
        self.active: set[asyncio.Task[Any]] = set()
        self.execution_marker: Path | None = None

    async def __aenter__(self) -> Gateway:
        if not os.environ.get(self.model.api_key_env):
            raise ValueError(f"Missing credential environment variable: {self.model.api_key_env}")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        app = web.Application(client_max_size=128 * 1024**2)
        app.router.add_post("/v1/{route:.*}", self.handle)
        self.runner = web.AppRunner(app, handler_cancellation=True, shutdown_timeout=5)
        await self.runner.setup()
        await web.TCPSite(self.runner, self.bind, 0).start()
        self.url = f"http://{self.advertised}:{self.runner.addresses[0][1]}/v1"
        self.client = aiohttp.ClientSession(timeout=self.timeout, trust_env=True)
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        for task in list(self.active):
            task.cancel()
        if self.active:
            await asyncio.gather(*list(self.active), return_exceptions=True)
        if self.runner:
            await self.runner.cleanup()
        if self.client:
            await self.client.close()

    def effective(self, body: dict[str, Any], protocol: str) -> tuple[dict[str, Any], str | None]:
        if body.get("model") not in {self.model.model, "benchmark/" + self.model.model}:
            raise ValueError("Requested model differs from the frozen model profile")
        if body.get("n", 1) != 1:
            raise ValueError("Multiple completions are unsupported")
        bridge = BRIDGE_VERSION if protocol != self.model.protocol else None
        if bridge:
            body = responses_to_chat(body) if protocol == "responses" else chat_to_responses(body)
        else:
            body = dict(body)
        if self.model.protocol == "chat-completions" and not self.model.supports_developer_role:
            if bridge:
                body["messages"] = [
                    {**message, "role": "system"} if message.get("role") == "developer" else message
                    for message in body["messages"]
                ]
            elif any(message.get("role") == "developer" for message in body.get("messages", [])):
                raise ValueError("Native harness ignored the model's disabled developer-role capability")
        body["model"] = self.model.model
        for key in MODEL_PARAMETERS:
            body.pop(key, None)
        output_key = "max_tokens" if self.model.protocol == "chat-completions" else "max_output_tokens"
        if self.model.protocol == "chat-completions":
            body.pop("max_completion_tokens", None)
        body[output_key] = self.model.max_output_tokens
        body.update(self.model.parameters)
        if self.model.protocol == "chat-completions" and body.get("stream"):
            body["stream_options"] = {**body.get("stream_options", {}), "include_usage": True}
        return body, bridge

    async def handle(self, request: web.Request) -> web.StreamResponse:
        if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + self.token):
            raise web.HTTPUnauthorized()
        route = request.match_info["route"]
        protocols = {"responses": "responses", "chat/completions": "chat-completions"}
        if route not in protocols:
            raise web.HTTPBadRequest(text="Unsupported model endpoint")
        protocol = protocols[route]
        original: Any = None
        try:
            original = await request.json()
            if not isinstance(original, dict):
                raise ValueError("Expected a JSON object")
            effective, bridge = self.effective(original, protocol)
        except (ValueError, KeyError, TypeError) as error:
            atomic_json(
                self.directory / ("rejected-" + uuid.uuid4().hex + ".json"),
                {
                    "request": original,
                    "error": str(error),
                    "dispatched": False,
                },
            )
            raise web.HTTPBadRequest(text=str(error)) from error
        identity = uuid.uuid4().hex
        directory = self.directory / identity
        directory.mkdir(mode=0o700)
        started = time.time()
        record: dict[str, Any] = {
            "version": 1,
            "id": identity,
            "status": "dispatching",
            "protocol": self.model.protocol,
            "downstream_protocol": protocol,
            "bridge": bridge,
            "model_parameter_policy": "profile-exclusive-v1",
            "developer_role_supported": self.model.supports_developer_role,
            "parameter_overrides": {
                key: {"native": original.get(key), "effective": effective.get(key)}
                for key in MODEL_PARAMETERS
                if original.get(key) != effective.get(key)
            },
            "started_at": started,
            "usage": None,
            "model": self.model.model,
            "client_request_id": request.headers.get("x-benchmark-client-request"),
            "http_status": None,
            "first_byte_at": None,
            "ended_at": None,
        }
        payload = json.dumps(effective, ensure_ascii=False, separators=(",", ":")).encode()
        for name, retained_bytes in [("upstream.bin", payload), ("downstream.bin", await request.read())]:
            with (directory / name).open("wb") as file:
                file.write(retained_bytes)
                file.flush()
                os.fsync(file.fileno())
        record["request_bytes"] = len(payload)
        record["request_field_bytes"] = {
            key: len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
            for key, value in effective.items()
        }
        record["byte_accounting"] = "UTF-8 JSON field values; non-additive with framing"
        atomic_json(directory / "downstream.json", original)
        atomic_json(directory / "upstream.json", effective)
        atomic_json(directory / "request.json", record)
        if self.execution_marker is not None and not self.execution_marker.exists():
            atomic_json(self.execution_marker, {"started_at": time.time() * 1000})
            self.execution_marker.chmod(0o644)
        task = asyncio.current_task()
        assert task is not None and self.client is not None
        self.active.add(task)
        upstream_route = "responses" if self.model.protocol == "responses" else "chat/completions"
        headers = {"Authorization": "Bearer " + os.environ[self.model.api_key_env], "Content-Type": "application/json"}
        response: web.StreamResponse | None = None
        converted: BinaryIO | None = None
        usage = None
        terminal = False
        try:
            async with self.client.post(
                self.model.base_url.rstrip("/") + "/" + upstream_route,
                data=payload,
                headers=headers,
                allow_redirects=False,
            ) as upstream:
                record["http_status"] = upstream.status
                record["retry_after"] = upstream.headers.get("Retry-After")
                record["headers_at"] = time.time()
                atomic_json(directory / "request.json", record)
                if upstream.status != 200:
                    payload = await upstream.read()
                    (directory / "response.bin").write_bytes(payload)
                    record["status"] = "http_error"
                    return web.Response(
                        status=upstream.status,
                        body=payload,
                        headers={
                            "Content-Type": upstream.headers.get("Content-Type", "application/octet-stream"),
                            **({"Retry-After": record["retry_after"]} if record["retry_after"] else {}),
                        },
                    )
                streaming = bool(effective.get("stream"))
                response = web.StreamResponse(
                    headers={
                        "Content-Type": "text/event-stream" if streaming else "application/json",
                        "X-Benchmark-Request": identity,
                    }
                )
                await response.prepare(request)
                if bridge:
                    converted = (directory / "downstream-response.bin").open("wb", buffering=0)

                async def write(payload: bytes) -> None:
                    if converted is not None:
                        converted.write(payload)
                    await response.write(payload)

                catalog = tool_catalog(original.get("tools", [])) if protocol == "responses" else {}
                custom = {name for name, tool in catalog.items() if tool.get("type") == "custom"}
                converter = (
                    ResponseStream(custom, self.model.model, catalog)
                    if protocol == "responses"
                    else ChatStream(self.model.model)
                )
                if bridge and isinstance(converter, ResponseStream):
                    record["downstream_response_id"] = converter.response["id"]

                async def emit(event: dict[str, Any]) -> None:
                    prefix = "event: " + event["type"] + "\n" if protocol == "responses" else ""
                    await write((prefix + "data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())

                if bridge and streaming and isinstance(converter, ResponseStream):
                    for event in converter.begin():
                        await emit(event)
                with (directory / "response.bin").open("wb", buffering=0) as raw:
                    if not streaming:
                        payload = await upstream.read()
                        raw.write(payload)
                        value = json.loads(payload)
                        if not bridge and protocol == "responses":
                            record["downstream_response_id"] = value.get("id")
                        usage = value.get("usage")
                        terminal = True
                        if bridge and isinstance(converter, ResponseStream):
                            converter.accept(value)
                            converter.end()
                            payload = json.dumps(converter.response).encode()
                        elif bridge:
                            chunks = converter.accept({"type": "response.completed", "response": value})
                            message: dict[str, Any] = {
                                "role": "assistant",
                                "content": "".join(
                                    part.get("text", "")
                                    for item in value.get("output", [])
                                    if item["type"] == "message"
                                    for part in item["content"]
                                ),
                            }
                            calls = [
                                {
                                    "id": item["call_id"],
                                    "type": "function",
                                    "function": {"name": item["name"], "arguments": item["arguments"]},
                                }
                                for item in value.get("output", [])
                                if item["type"] == "function_call"
                            ]
                            if calls:
                                message["tool_calls"] = calls
                            payload = json.dumps(
                                {
                                    "id": value["id"],
                                    "object": "chat.completion",
                                    "model": self.model.model,
                                    "choices": [
                                        {
                                            "index": 0,
                                            "message": message,
                                            "finish_reason": "tool_calls" if calls else "stop",
                                        }
                                    ],
                                    "usage": chunks[0].get("usage"),
                                }
                            ).encode()
                        await write(payload)
                    else:
                        data_lines: list[str] = []
                        async for line in stream_lines(upstream.content):
                            raw.write(line)
                            if record["first_byte_at"] is None:
                                record["first_byte_at"] = time.time()
                            if not bridge:
                                await write(line)
                            decoded = line.decode("utf-8").rstrip("\r\n")
                            if decoded.startswith("data:"):
                                data_lines.append(decoded[5:].lstrip())
                            if decoded or not data_lines:
                                continue
                            data = "\n".join(data_lines)
                            data_lines = []
                            if data == "[DONE]":
                                terminal = True
                                continue
                            chunk = json.loads(data)
                            current = chunk.get("response", chunk)
                            if not bridge and protocol == "responses" and current.get("id"):
                                record["downstream_response_id"] = current["id"]
                            if current.get("usage") is not None:
                                usage = current["usage"]
                            if chunk.get("type") in {"response.completed", "response.incomplete"}:
                                terminal = True
                            if chunk.get("type") in {"response.failed", "error"} or chunk.get("error"):
                                raise ValueError("Provider reported a stream error")
                            if bridge:
                                for event in converter.accept(chunk):
                                    await emit(event)
                        if data_lines:
                            raise ValueError("Truncated SSE event")
                        if not terminal:
                            raise ValueError("Provider stream ended without a terminal marker")
                        if bridge and isinstance(converter, ResponseStream):
                            for event in converter.end():
                                await emit(event)
                        elif bridge:
                            await write(b"data: [DONE]\n\n")
                    raw.flush()
                    os.fsync(raw.fileno())
                if not terminal:
                    raise ValueError("Provider stream ended without a terminal marker")
                record["status"] = "completed"
                record["usage"] = usage
                await response.write_eof()
                return response
        except (asyncio.CancelledError, ConnectionError):
            record["status"] = "interrupted"
            raise
        except Exception as error:
            record["status"] = "failed"
            record["error"] = type(error).__name__
            if response is not None:
                request.transport.close() if request.transport else None
                return response
            raise web.HTTPBadGateway(text="Model request failed; retained in benchmark ledger") from error
        finally:
            if converted is not None:
                try:
                    os.fsync(converted.fileno())
                finally:
                    converted.close()
            if record["usage"] is None and usage is not None:
                record["observed_usage"] = usage
            raw_path = directory / "response.bin"
            record["response_bytes"] = raw_path.stat().st_size if raw_path.exists() else None
            if raw_path.exists():
                with raw_path.open("rb") as retained:
                    os.fsync(retained.fileno())
            record["ended_at"] = time.time()
            atomic_json(directory / "request.json", record)
            self.active.discard(task)
