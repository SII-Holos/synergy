import json

import pytest

from synergy_bench.bridge import BRIDGE_VERSION, chat_to_responses, response_events, responses_to_chat


def test_responses_history_preserves_custom_tool_and_reasoning():
    value = responses_to_chat(
        {
            "model": "fixture",
            "stream": True,
            "instructions": "native system",
            "tools": [{"type": "custom", "name": "apply_patch", "description": "patch"}],
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "fix it"}]},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "inspect first"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "done"},
            ],
        }
    )
    assert BRIDGE_VERSION == "responses-chat-v2"
    assert value["messages"][0] == {"role": "system", "content": "native system"}
    assistant = value["messages"][2]
    assert assistant["reasoning_content"] == "inspect first"
    assert json.loads(assistant["tool_calls"][0]["function"]["arguments"]) == {"input": "*** patch"}
    assert value["messages"][3] == {"role": "tool", "tool_call_id": "call_1", "content": "done"}


def test_bridge_rejects_unrepresentable_inputs_instead_of_dropping_them():
    with pytest.raises(ValueError, match="Unsupported"):
        responses_to_chat({"model": "fixture", "input": [{"type": "computer_call", "action": {}}]})
    with pytest.raises(ValueError, match="previous_response_id"):
        responses_to_chat({"model": "fixture", "previous_response_id": "unavailable", "input": []})


@pytest.mark.parametrize("url", ["https://example.test/image.png", "data:image/png;base64,fixture"])
@pytest.mark.parametrize("detail", [None, "auto", "low", "high"])
def test_image_content_roundtrips_without_changing_tool_identity_or_part_order(url, detail):
    image = {"type": "input_image", "image_url": url, **({"detail": detail} if detail else {})}
    content = [{"type": "input_text", "text": "before"}, image, {"type": "input_text", "text": "after"}]
    original = {
        "model": "fixture",
        "input": [
            {"role": "user", "content": content},
            {"type": "function_call", "name": "view_image", "call_id": "picture", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "picture", "output": content},
        ],
    }
    retained = json.dumps(original)
    chat_content = [
        {"type": "text", "text": "before"},
        {"type": "image_url", "image_url": {"url": url, **({"detail": detail} if detail else {})}},
        {"type": "text", "text": "after"},
    ]
    mapped = responses_to_chat(original)
    assert mapped["messages"][0] == {"role": "user", "content": chat_content}
    assert mapped["messages"][-1] == {"role": "tool", "tool_call_id": "picture", "content": chat_content}
    roundtrip = chat_to_responses(mapped)
    assert roundtrip["input"][0] == original["input"][0]
    assert roundtrip["input"][-1] == original["input"][-1]
    assert json.dumps(original) == retained


def test_custom_tool_can_return_multiple_images_without_a_synthetic_user_message():
    images = [{"type": "input_image", "image_url": f"https://example.test/{i}.png"} for i in range(2)]
    mapped = responses_to_chat(
        {"model": "fixture", "input": [{"type": "custom_tool_call_output", "call_id": "c", "output": images}]}
    )
    assert mapped["messages"] == [
        {
            "role": "tool",
            "tool_call_id": "c",
            "content": [{"type": "image_url", "image_url": {"url": part["image_url"]}} for part in images],
        }
    ]


@pytest.mark.parametrize(
    "part",
    [
        {"type": "input_image", "file_id": "file_requires_lookup"},
        {"type": "input_image", "image_url": "https://example.test/image.png", "detail": "unrepresentable"},
        {"type": "input_audio", "data": "opaque"},
        {"type": "input_file", "file_id": "file_requires_lookup"},
    ],
)
def test_multimodal_bridge_rejects_unrepresentable_parts_instead_of_omitting_them(part):
    with pytest.raises(ValueError, match="Unsupported"):
        responses_to_chat({"model": "fixture", "input": [{"role": "user", "content": [part]}]})


@pytest.mark.parametrize(
    "part",
    [
        {"type": "image_url", "image_url": "https://example.test/image.png"},
        {"type": "image_url", "image_url": {"url": "", "detail": "high"}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture", "detail": []}},
        {"type": "image_url", "image_url": {"url": "https://example.test/image.png", "unmapped": True}},
        {"type": "input_audio", "input_audio": {"data": "opaque", "format": "wav"}},
    ],
)
def test_chat_images_reject_invalid_or_unmapped_fields(part):
    with pytest.raises(ValueError, match="Unsupported"):
        chat_to_responses({"model": "fixture", "messages": [{"role": "tool", "tool_call_id": "c", "content": [part]}]})


def test_chat_to_responses_preserves_parallel_calls_and_tool_results():
    response = chat_to_responses(
        {
            "model": "two",
            "messages": [
                {"role": "user", "content": "hello"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {"id": "a", "type": "function", "function": {"name": "read", "arguments": "{}"}},
                        {"id": "b", "type": "function", "function": {"name": "exec", "arguments": "{}"}},
                    ],
                },
                {"role": "tool", "tool_call_id": "a", "content": "value"},
            ],
        }
    )
    assert [item.get("type") for item in response["input"]] == [
        None,
        "function_call",
        "function_call",
        "function_call_output",
    ]
    assert response["input"][-1]["call_id"] == "a"


def test_responses_stream_keeps_usage_and_custom_tool_input():
    chunks = [
        {"choices": [{"delta": {"reasoning_content": "check"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "call_a", "function": {"name": "patch", "arguments": '{"input":"hi"}'}}
                        ]
                    }
                }
            ]
        },
        {
            "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 15, "completion_tokens": 7},
        },
    ]
    events = list(response_events(chunks, {"patch"}, "m"))
    assert events[0]["type"] == "response.created"
    response = events[-1]["response"]
    assert response["usage"]["input_tokens"] == 15
    assert response["usage"]["output_tokens"] == 7
    call = next(item for item in response["output"] if item["type"] == "custom_tool_call")
    assert call["input"] == "hi"
    assert call["call_id"] == "call_a"
    assert len([event for event in events if event["type"] == "response.completed"]) == 1


def test_namespace_tool_roundtrip_does_not_collide_with_global_tools():
    from synergy_bench.bridge import ResponseStream, tool_catalog

    body = {
        "model": "m",
        "tools": [
            {
                "type": "namespace",
                "name": "workers",
                "description": "Native workers",
                "tools": [{"type": "function", "name": "spawn", "parameters": {"type": "object"}}],
            },
            {"type": "function", "name": "spawn", "parameters": {"type": "object"}},
        ],
        "input": [
            {"type": "function_call", "namespace": "workers", "name": "spawn", "call_id": "c", "arguments": "{}"}
        ],
    }
    mapped = responses_to_chat(body)
    assert [tool["function"]["name"] for tool in mapped["tools"]] == ["workers__spawn", "spawn"]
    assert mapped["messages"][0]["tool_calls"][0]["function"]["name"] == "workers__spawn"
    stream = ResponseStream(set(), "m", tool_catalog(body["tools"]))
    stream.accept(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"id": "c", "index": 0, "function": {"name": "workers__spawn", "arguments": "{}"}}
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
    )
    item = stream.end()[-1]["response"]["output"][0]
    assert item["name"] == "spawn" and item["namespace"] == "workers"


def test_responses_usage_derives_total_and_omits_unrepresentable_partial_usage():
    from synergy_bench.bridge import response_usage

    assert response_usage({"prompt_tokens": 12, "completion_tokens": 3}) == {
        "input_tokens": 12,
        "output_tokens": 3,
        "total_tokens": 15,
    }
    assert response_usage({"prompt_tokens": 12}) is None
    value = response_usage(
        {"prompt_tokens": 12, "completion_tokens": 3, "prompt_tokens_details": {"cached_tokens": None}}
    )
    assert "input_tokens_details" not in value


def test_bridge_keeps_developer_role_and_rejects_unsupported_chat_controls():
    mapped = responses_to_chat({"model": "m", "input": [{"role": "developer", "content": "policy"}]})
    assert mapped["messages"][0]["role"] == "developer"
    for controls in [{"stop": ["END"]}, {"n": 2}, {"seed": 3}, {"response_format": {"type": "json_object"}}]:
        with pytest.raises(ValueError, match="Unsupported"):
            chat_to_responses({"model": "m", "messages": [], **controls})


def test_namespace_tool_choice_uses_the_same_wire_name_as_catalog():
    value = responses_to_chat(
        {"model": "m", "input": [], "tool_choice": {"type": "function", "namespace": "worker", "name": "exec"}}
    )
    assert value["tool_choice"]["function"]["name"] == "worker__exec"


def test_reasoning_stays_with_assistant_text_and_its_tool_call():
    result = responses_to_chat(
        {
            "model": "fixture",
            "input": [
                {"role": "user", "content": "inspect"},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "Checking the file."}]},
                {"type": "function_call", "name": "read", "call_id": "one", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "one", "output": "contents"},
            ],
        }
    )
    assert len(result["messages"]) == 3
    assert result["messages"][1]["reasoning_content"] == "thinking"
    assert result["messages"][1]["content"] == "Checking the file."
    assert result["messages"][1]["tool_calls"][0]["id"] == "one"
