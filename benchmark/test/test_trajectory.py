import json
import zipfile

import pytest

from synergy_bench.storage import atomic_json, digest
from synergy_bench.trajectory import (
    analyze_run,
    interval_seconds,
    payload_profile,
    request_summary,
    rollout_tables,
    stream_profile,
    write_analysis,
)


def retained_run(root):
    atomic_json(root / "plan.json", {"version": 4, "result_version": 5, "schedule": [{"task": "fixture"}]})
    attempt = root / "trials/0000/attempt-001"
    body = {
        "messages": [
            {"role": "system", "content": "private instruction"},
            {"role": "user", "content": "private task"},
            {"role": "assistant", "reasoning_content": "旧思考", "content": "answer"},
            {"role": "tool", "tool_call_id": "t", "content": "private result"},
        ],
        "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}],
    }
    usage = {
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "prompt_tokens_details": {"cached_tokens": 60},
        "completion_tokens_details": {"reasoning_tokens": 15},
    }
    native = []
    attempts = []
    for index, status in enumerate([429, 200, 200]):
        request = {
            "id": str(index),
            "protocol": "chat-completions",
            "status": "completed" if index < 2 else "interrupted",
            "http_status": status,
            "started_at": 10 + index * 10,
            "ended_at": 20 + index * 10,
            "first_byte_at": 11 + index * 10,
            "usage": usage if index == 1 else None,
            "observed_usage": usage if index == 2 else None,
        }
        wire = attempt / f"wire/{index}"
        atomic_json(wire / "request.json", request)
        atomic_json(wire / "downstream.json", body)
        atomic_json(wire / "upstream.json", body)
        native.append({"id": str(index), "request_digest": digest(body), "purpose": "synergy-max"})
        attempts.append({"id": str(index), "callID": "call", "started": request["started_at"] * 1000})
    atomic_json(attempt / "trial.json", {"task": "fixture"})
    atomic_json(
        attempt / "evidence.json",
        {
            "version": 5,
            "accounting": {"request_records": native},
            "execution": {"started_at": 0, "ended_at": 50000, "wall_ms": 50000, "outcome": "timeout"},
            "verifier": {"rewards": {"reward": 1}},
            "evidence": {"valid": False},
        },
    )
    session = {
        "info": {"id": "root"},
        "messages": [
            {
                "info": {"id": "m", "role": "assistant"},
                "parts": [
                    {
                        "type": "tool",
                        "callID": "t",
                        "tool": "bash",
                        "state": {
                            "input": {"command": "private command"},
                            "output": "private result",
                            "status": "completed",
                        },
                    },
                ],
            }
        ],
    }
    manifest = {
        "format": "synergy-rollout",
        "version": 1,
        "rootSessionID": "root",
        "snapshots": [
            {
                "owner": {"sessionID": "root"},
                "calls": [{"id": "call", "purpose": "synergy-max"}],
                "attempts": attempts,
                "tools": [
                    {
                        "id": "tool",
                        "toolCallID": "t",
                        "tool": "bash",
                        "started": 15000,
                        "ended": 25000,
                        "status": "completed",
                    }
                ],
            }
        ],
    }
    agent = attempt / "native/agent"
    agent.mkdir(parents=True)
    with zipfile.ZipFile(agent / "rollout.zip", "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("transcript.json", json.dumps({"sessions": [session]}))
    return root


def test_overlap_is_union_and_clipped_not_sum():
    assert interval_seconds([(1, 5), (3, 8), (10, 13)], (2, 12)) == 8
    assert interval_seconds([]) == 0


def test_payload_bytes_do_not_pretend_to_be_tokens():
    profile = payload_profile({"messages": [{"role": "assistant", "reasoning_content": "思考"}]})
    assert profile["historical_reasoning_bytes"] == 6
    assert profile["tool_schema_bytes"] == 0
    assert "tokens" not in profile


def test_partial_field_usage_preserves_known_total_lower_bound():
    summary = request_summary(
        [
            {
                "usage_complete": False,
                "input": 100,
                "output": None,
                "total": None,
                "started_at": 0,
                "ended_at": 1,
            }
        ]
    )
    assert summary["known_total"] == 100
    assert summary["unknown_output_requests"] == 1
    assert summary["total_tokens"] is None


def test_missing_cache_or_reasoning_does_not_claim_a_zero_rate():
    summary = request_summary(
        [{"usage_complete": True, "input": 100, "output": 20, "cache_read": None, "reasoning": None}]
    )
    assert summary["known_total"] == 120
    assert summary["total_tokens"] == 120
    assert summary["cache_rate_known"] is None
    assert summary["reasoning_share_known"] is None


def test_stream_profile_counts_fragmented_tools_and_accepts_done_without_space(tmp_path):
    path = tmp_path / "response.bin"
    events = [
        {"choices": [{"index": 0, "delta": {"reasoning_content": "思考"}}]},
        {"choices": [{"index": 0, "delta": {"content": "visible"}}]},
        {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{"}}]}}]},
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "}"}}]},
                    "finish_reason": "tool_calls",
                }
            ]
        },
        {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 2}},
    ]
    path.write_text("".join("data: " + json.dumps(e) + "\n\n" for e in events) + "data:[DONE]\n\ndata: torn{")
    profile = stream_profile(path)
    assert profile["response_reasoning_bytes"] == 6
    assert profile["response_text_bytes"] == 7
    assert profile["response_tool_argument_bytes"] == 2
    assert profile["response_tool_calls"] == 1
    assert profile["stream_usage_frames"] == 1
    assert profile["stream_invalid_lines"] == 1
    assert profile["finish_reasons"] == "tool_calls"


@pytest.mark.parametrize(
    "body", ['{"choices":[{"message":{"content":"answer"}}]}', "upstream unavailable", "", "data: null\n\n"]
)
def test_unrecognized_response_framing_keeps_stream_measurements_unknown(tmp_path, body):
    path = tmp_path / "response.bin"
    path.write_text(body)
    profile = stream_profile(path)
    assert profile["stream_framing"] == "unknown"
    assert profile["response_text_bytes"] is None
    assert profile["response_reasoning_bytes"] is None
    assert profile["response_tool_argument_bytes"] is None
    assert profile["response_tool_calls"] is None
    assert profile["stream_usage_frames"] is None
    assert profile["finish_reasons"] is None


def test_missing_response_keeps_stream_measurements_unknown(tmp_path):
    profile = stream_profile(tmp_path / "missing.bin")
    assert profile["stream_missing"] is True
    assert profile["response_text_bytes"] is None


def test_cli_rejects_ancestor_output_before_reading_evidence(tmp_path, monkeypatch, capsys):
    from synergy_bench.trajectory import main

    monkeypatch.setattr("sys.argv", ["trajectory", str(tmp_path / "run"), "--output", str(tmp_path)])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2
    assert "disjoint" in capsys.readouterr().err


def test_retains_retry_unknown_usage_and_timeout_reward(tmp_path):
    result = analyze_run(retained_run(tmp_path / "run"))
    rows = result["requests"]
    assert len(rows) == 3
    assert [r["purpose"] for r in rows] == ["synergy-max"] * 3
    assert [r["match"] for r in rows] == ["ordered_duplicate"] * 3
    summary = result["summary"]["trials"]
    assert summary["known_input"] == 200
    assert summary["known_output"] == 40
    assert summary["known_total"] == 240
    assert summary["known_cache_read"] == 120
    assert summary["unknown_usage_requests"] == 2
    assert summary["total_tokens"] is None
    assert result["attempts"][0]["reward"] == 1
    assert result["attempts"][0]["request_union_seconds"] == 30
    assert result["attempts"][0]["model_or_tool_union_seconds"] == 30
    assert result["tools"][0]["output_bytes"] == len("private result")


def test_export_omits_payloads_and_refuses_to_write_into_evidence(tmp_path):
    root = retained_run(tmp_path / "run")
    result = analyze_run(root)
    output = tmp_path / "analysis"
    write_analysis(result, output, root)
    rendered = "\n".join(p.read_text() for p in output.iterdir() if p.is_file())
    assert "private instruction" not in rendered
    assert "private command" not in rendered
    assert "private result" not in rendered
    assert (output / "requests.csv").exists()
    with pytest.raises(ValueError, match="outside"):
        write_analysis(result, root / "analysis", root)


def test_missing_terminal_evidence_cannot_produce_exact_total(tmp_path):
    root = retained_run(tmp_path / "run")
    (root / "trials/0000/attempt-001/evidence.json").unlink()
    result = analyze_run(root)
    assert result["summary"]["trials"]["total_tokens"] is None
    assert result["attempts"][0]["reward"] is None
    assert result["attempts"][0]["execution_seconds"] is None
    assert result["attempts"][0]["started_at"] is None
    assert result["attempts"][0]["ended_at"] is None


def test_missing_wire_ledger_cannot_silently_undercount(tmp_path):
    root = retained_run(tmp_path / "run")
    (root / "trials/0000/attempt-001/wire/0/request.json").unlink()
    with pytest.raises(ValueError, match="metadata"):
        analyze_run(root)


def test_native_attempt_without_wire_keeps_total_unknown(tmp_path):
    import shutil

    root = retained_run(tmp_path / "run")
    shutil.rmtree(root / "trials/0000/attempt-001/wire")
    result = analyze_run(root)
    assert result["attempts"][0]["missing_wire_attempts"] == 3
    assert result["attempts"][0]["total_tokens"] is None
    assert result["summary"]["trials"]["total_tokens"] is None


def test_sibling_sessions_can_reuse_provider_tool_call_ids():
    snapshots, sessions = [], []
    for sid, output in [("root", "a"), ("child", "longer")]:
        snapshots.append({"owner": {"sessionID": sid}, "tools": [{"toolCallID": "same", "tool": "bash"}]})
        sessions.append(
            {
                "info": {"id": sid},
                "messages": [
                    {
                        "info": {"role": "assistant"},
                        "parts": [
                            {
                                "type": "tool",
                                "callID": "same",
                                "state": {"output": output},
                            }
                        ],
                    }
                ],
            }
        )
    tools, owners, _, _ = rollout_tables({"rootSessionID": "root", "snapshots": snapshots}, {"sessions": sessions}, {})
    assert [t["output_bytes"] for t in tools] == [1, 6]
    assert [t["is_root"] for t in tools] == [True, False]
    assert len(owners) == 2


def test_purpose_totals_preserve_missing_terminal_evidence(tmp_path):
    root = retained_run(tmp_path / "run")
    attempt = root / "trials/0000/attempt-001"
    for path in (attempt / "wire").glob("*/request.json"):
        record = json.loads(path.read_text())
        record["usage"] = {"prompt_tokens": 100, "completion_tokens": 20}
        atomic_json(path, record)
    (attempt / "evidence.json").unlink()
    result = analyze_run(root)
    assert result["summary"]["trials"]["total_tokens"] is None
    assert result["by_purpose"][0]["known_total"] == 360
    assert result["by_purpose"][0]["total_tokens"] is None
