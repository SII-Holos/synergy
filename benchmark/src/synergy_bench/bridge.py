from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterable, Iterator
from typing import Any

# Wire contracts: https://platform.openai.com/docs/api-reference/responses-streaming
# and https://platform.openai.com/docs/api-reference/chat/streaming . No agent policy lives here.
BRIDGE_VERSION = "responses-chat-v1"


def wire_name(name: str, namespace: str | None = None) -> str:
    return namespace + "__" + name if namespace else name


def tool_catalog(tools: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result = {}
    for tool in tools:
        nested = tool.get("tools", []) if tool["type"] == "namespace" else [tool]
        for child in nested:
            value = dict(child)
            if tool["type"] == "namespace":
                value["namespace"] = tool["name"]
                value["description"] = tool.get("description", "") + "\n" + child.get("description", "")
            key = wire_name(value.get("name", ""), value.get("namespace"))
            if key in result:
                raise ValueError("Tool names collide after namespace conversion")
            result[key] = value
    return result


def content_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(
        isinstance(part, dict) and part.get("type") in {"input_text", "output_text", "text", "summary_text"}
        for part in value
    ):
        return "".join(part["text"] for part in value)
    raise ValueError("Unsupported non-text content in the text protocol bridge")


def responses_to_chat(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("previous_response_id"):
        raise ValueError("previous_response_id requires retained history; send explicit input")
    if body.get("background"):
        raise ValueError("Unsupported background response")
    messages: list[dict[str, Any]] = []
    if body.get("instructions"):
        messages.append({"role": "system", "content": body["instructions"]})
    inputs = body.get("input", [])
    if isinstance(inputs, str):
        inputs = [{"role": "user", "content": inputs}]
    for item in inputs:
        kind = item.get("type", "message")
        if kind == "message":
            role = item["role"]
            content = content_text(item["content"])
            if (
                role == "assistant"
                and messages
                and messages[-1]["role"] == "assistant"
                and messages[-1].get("content") is None
                and "reasoning_content" in messages[-1]
                and not messages[-1].get("tool_calls")
            ):
                messages[-1]["content"] = content
            else:
                messages.append({"role": role, "content": content})
        elif kind in {"function_call", "custom_tool_call", "reasoning"}:
            if not messages or messages[-1]["role"] != "assistant":
                messages.append({"role": "assistant", "content": None})
            message = messages[-1]
            if kind == "reasoning":
                if item.get("encrypted_content"):
                    raise ValueError("Unsupported encrypted reasoning from another protocol")
                message["reasoning_content"] = message.get("reasoning_content", "") + content_text(
                    item.get("summary", [])
                )
            else:
                arguments = item["arguments"] if kind == "function_call" else json.dumps({"input": item["input"]})
                message.setdefault("tool_calls", []).append(
                    {
                        "id": item["call_id"],
                        "type": "function",
                        "function": {"name": wire_name(item["name"], item.get("namespace")), "arguments": arguments},
                    }
                )
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            messages.append({"role": "tool", "tool_call_id": item["call_id"], "content": content_text(item["output"])})
        else:
            raise ValueError(f"Unsupported Responses input: {kind}")
    tools = []
    for name, tool in tool_catalog(body.get("tools", [])).items():
        if tool["type"] == "function":
            function = {key: tool[key] for key in ["name", "description", "parameters", "strict"] if key in tool}
        elif tool["type"] == "custom":
            description = tool.get("description", "")
            if tool.get("format"):
                description += "\nRequired input format:\n" + json.dumps(tool["format"], ensure_ascii=False)
            function = {
                "name": tool["name"],
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {"input": {"type": "string"}},
                    "required": ["input"],
                    "additionalProperties": False,
                },
            }
        else:
            raise ValueError(f"Unsupported Responses tool: {tool['type']}")
        function["name"] = name
        tools.append({"type": "function", "function": function})
    result = {"model": body["model"], "messages": messages, "stream": body.get("stream", False)}
    if tools:
        result["tools"] = tools
    for key in ["temperature", "top_p", "parallel_tool_calls"]:
        if key in body:
            result[key] = body[key]
    if "max_output_tokens" in body:
        result["max_tokens"] = body["max_output_tokens"]
    if body.get("reasoning", {}).get("effort"):
        result["reasoning_effort"] = body["reasoning"]["effort"]
    if "tool_choice" in body:
        choice = body["tool_choice"]
        result["tool_choice"] = (
            {"type": "function", "function": {"name": wire_name(choice["name"], choice.get("namespace"))}}
            if isinstance(choice, dict) and choice.get("type") in {"function", "custom"}
            else choice
        )
    if body.get("text", {}).get("format", {}).get("type", "text") != "text":
        raise ValueError("Unsupported structured text format in Responses bridge")
    return result


def chat_to_responses(body: dict[str, Any]) -> dict[str, Any]:
    unsupported = [
        key for key in ["stop", "seed", "logit_bias", "logprobs", "top_logprobs"] if body.get(key) is not None
    ]
    if body.get("n", 1) != 1:
        unsupported.append("n")
    if body.get("response_format", {}).get("type", "text") != "text":
        unsupported.append("response_format")
    if any(body.get(key, 0) != 0 for key in ["frequency_penalty", "presence_penalty"]):
        unsupported.append("penalties")
    if unsupported:
        raise ValueError(f"Unsupported Chat controls in Responses bridge: {unsupported}")
    inputs = []
    for message in body.get("messages", []):
        role = message["role"]
        if role == "tool":
            inputs.append(
                {
                    "type": "function_call_output",
                    "call_id": message["tool_call_id"],
                    "output": content_text(message["content"]),
                }
            )
            continue
        if message.get("reasoning_content"):
            inputs.append(
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": message["reasoning_content"]}]}
            )
        if message.get("content") is not None:
            inputs.append({"role": role, "content": content_text(message["content"])})
        for call in message.get("tool_calls", []):
            inputs.append({"type": "function_call", "call_id": call["id"], **call["function"]})
    result = {"model": body["model"], "input": inputs, "stream": body.get("stream", False), "store": False}
    if body.get("tools"):
        result["tools"] = [{"type": "function", **tool["function"]} for tool in body["tools"]]
    for key in ["temperature", "top_p", "parallel_tool_calls"]:
        if key in body:
            result[key] = body[key]
    if "max_tokens" in body or "max_completion_tokens" in body:
        result["max_output_tokens"] = body.get("max_completion_tokens", body.get("max_tokens"))
    if body.get("reasoning_effort"):
        result["reasoning"] = {"effort": body["reasoning_effort"]}
    if "tool_choice" in body:
        choice = body["tool_choice"]
        result["tool_choice"] = (
            {"type": "function", "name": choice["function"]["name"]} if isinstance(choice, dict) else choice
        )
    return result


def response_usage(value: dict[str, Any]) -> dict[str, Any] | None:
    from .usage import normalize_usage

    normalized = normalize_usage(value, "chat-completions")
    if normalized["total"] is None:
        return None
    result: dict[str, Any] = {
        "input_tokens": normalized["input"],
        "output_tokens": normalized["output"],
        "total_tokens": normalized["total"],
    }
    for field, target, key in [
        ("cacheRead", "input_tokens_details", "cached_tokens"),
        ("reasoning", "output_tokens_details", "reasoning_tokens"),
    ]:
        if normalized[field] is not None:
            result[target] = {key: normalized[field]}
    return result


class ResponseStream:
    def __init__(self, custom: set[str], model: str, catalog: dict[str, dict[str, Any]] | None = None) -> None:
        self.custom = custom
        self.catalog = catalog or {}
        self.response: dict[str, Any] = {
            "id": "resp_" + uuid.uuid4().hex,
            "object": "response",
            "model": model,
            "created_at": int(time.time()),
            "status": "in_progress",
            "output": [],
            "usage": None,
        }
        self.calls: dict[int, dict[str, Any]] = {}
        self.text: dict[str, Any] | None = None
        self.reasoning: dict[str, Any] | None = None
        self.sequence = 0
        self.finished = False
        self.finish_reason: str | None = None

    def event(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        value = {"type": kind, "sequence_number": self.sequence, **kwargs}
        self.sequence += 1
        snapshot: dict[str, Any] = json.loads(json.dumps(value))
        return snapshot  # Events are immutable snapshots, never references to later state.

    def begin(self) -> list[dict[str, Any]]:
        return [
            self.event("response.created", response=self.response),
            self.event("response.in_progress", response=self.response),
        ]

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        item["id"] = item.get("id", "item_" + uuid.uuid4().hex)
        self.response["output"].append(item)
        return self.event("response.output_item.added", output_index=len(self.response["output"]) - 1, item=item)

    def accept(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        if self.finished:
            raise ValueError("Stream already terminated")
        events = []
        if chunk.get("usage") is not None:
            self.response["usage"] = response_usage(chunk["usage"])
        for choice in chunk.get("choices", []):
            if choice.get("index", 0) != 0:
                raise ValueError("Only a single completion is supported")
            self.finish_reason = choice.get("finish_reason") or self.finish_reason
            delta = choice.get("delta", choice.get("message", {}))
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoning:
                if self.reasoning is None:
                    self.reasoning = {"type": "reasoning", "summary": [{"type": "summary_text", "text": ""}]}
                    events.append(self.add(self.reasoning))
                    events.append(
                        self.event(
                            "response.reasoning_summary_part.added",
                            item_id=self.reasoning["id"],
                            output_index=self.response["output"].index(self.reasoning),
                            summary_index=0,
                            part=self.reasoning["summary"][0],
                        )
                    )
                self.reasoning["summary"][0]["text"] += reasoning
                events.append(
                    self.event(
                        "response.reasoning_summary_text.delta",
                        item_id=self.reasoning["id"],
                        output_index=self.response["output"].index(self.reasoning),
                        summary_index=0,
                        delta=reasoning,
                    )
                )
            if delta.get("content"):
                if self.text is None:
                    self.text = {
                        "type": "message",
                        "role": "assistant",
                        "status": "in_progress",
                        "content": [{"type": "output_text", "text": "", "annotations": []}],
                    }
                    events.append(self.add(self.text))
                    events.append(
                        self.event(
                            "response.content_part.added",
                            item_id=self.text["id"],
                            output_index=self.response["output"].index(self.text),
                            content_index=0,
                            part=self.text["content"][0],
                        )
                    )
                self.text["content"][0]["text"] += delta["content"]
                events.append(
                    self.event(
                        "response.output_text.delta",
                        item_id=self.text["id"],
                        output_index=self.response["output"].index(self.text),
                        content_index=0,
                        delta=delta["content"],
                    )
                )
            for call in delta.get("tool_calls", []):
                index = call.get("index", 0)
                function = call.get("function", {})
                if index not in self.calls:
                    if not call.get("id") or not function.get("name"):
                        raise ValueError("Tool stream began without identity or name")
                    custom = function["name"] in self.custom
                    item = {
                        "type": "custom_tool_call" if custom else "function_call",
                        "call_id": call["id"],
                        "name": function["name"],
                        "status": "in_progress",
                        "input" if custom else "arguments": "",
                    }
                    declared = self.catalog.get(function["name"])
                    if declared:
                        item["name"] = declared["name"]
                        if declared.get("namespace"):
                            item["namespace"] = declared["namespace"]
                    self.calls[index] = {"item": item, "arguments": ""}
                    events.append(self.add(item))
                state = self.calls[index]
                state["arguments"] += function.get("arguments", "")
                item = state["item"]
                if item["type"] == "function_call":
                    item["arguments"] = state["arguments"]
                    events.append(
                        self.event(
                            "response.function_call_arguments.delta",
                            item_id=item["id"],
                            output_index=self.response["output"].index(item),
                            delta=function.get("arguments", ""),
                        )
                    )
        return events

    def end(self) -> list[dict[str, Any]]:
        if self.finished:
            return []
        self.finished = True
        if self.finish_reason is None:
            raise ValueError("Upstream stream ended without a completion boundary")
        events = []
        for state in self.calls.values():
            item = state["item"]
            index = self.response["output"].index(item)
            if item["type"] == "custom_tool_call":
                value = json.loads(state["arguments"])
                if not isinstance(value, dict) or not isinstance(value.get("input"), str):
                    raise ValueError("Custom tool did not return its string input")
                item["input"] = value["input"]
                events.append(
                    self.event(
                        "response.custom_tool_call_input.delta",
                        item_id=item["id"],
                        output_index=index,
                        delta=item["input"],
                    )
                )
                events.append(
                    self.event(
                        "response.custom_tool_call_input.done",
                        item_id=item["id"],
                        output_index=index,
                        input=item["input"],
                    )
                )
            else:
                events.append(
                    self.event(
                        "response.function_call_arguments.done",
                        item_id=item["id"],
                        output_index=index,
                        arguments=item["arguments"],
                    )
                )
        for index, item in enumerate(self.response["output"]):
            if item["type"] == "message":
                events.append(
                    self.event(
                        "response.output_text.done",
                        item_id=item["id"],
                        output_index=index,
                        content_index=0,
                        text=item["content"][0]["text"],
                    )
                )
                events.append(
                    self.event(
                        "response.content_part.done",
                        item_id=item["id"],
                        output_index=index,
                        content_index=0,
                        part=item["content"][0],
                    )
                )
            elif item["type"] == "reasoning":
                events.append(
                    self.event(
                        "response.reasoning_summary_text.done",
                        item_id=item["id"],
                        output_index=index,
                        summary_index=0,
                        text=item["summary"][0]["text"],
                    )
                )
                events.append(
                    self.event(
                        "response.reasoning_summary_part.done",
                        item_id=item["id"],
                        output_index=index,
                        summary_index=0,
                        part=item["summary"][0],
                    )
                )
            if "status" in item:
                item["status"] = "completed"
            events.append(self.event("response.output_item.done", output_index=index, item=item))
        incomplete = self.finish_reason == "length"
        self.response["status"] = "incomplete" if incomplete else "completed"
        if incomplete:
            self.response["incomplete_details"] = {"reason": "max_output_tokens"}
        events.append(self.event("response.incomplete" if incomplete else "response.completed", response=self.response))
        return events


def response_events(chunks: Iterable[dict[str, Any]], custom: set[str], model: str) -> Iterator[dict[str, Any]]:
    stream = ResponseStream(custom, model)
    yield from stream.begin()
    for chunk in chunks:
        yield from stream.accept(chunk)
    yield from stream.end()
