from synergy_bench.usage import aggregate_usage, normalize_usage


def test_interrupted_cumulative_usage_is_only_a_known_lower_bound():
    result = aggregate_usage(
        [
            {
                "id": "one",
                "protocol": "chat-completions",
                "status": "interrupted",
                "usage": None,
                "observed_usage": {"prompt_tokens": 10, "completion_tokens": 3},
            }
        ]
    )
    assert result["tokens"]["total"] == {"known": 13, "unknown": 1, "total": None}
    assert result["tokens"]["input"] == {"known": 10, "unknown": 1, "total": None}


def test_request_reconciliation_exposes_missing_and_duplicate_client_ids():
    from synergy_bench.native_usage import reconcile_requests

    native = {"source": "native-transport-pi", "records": [{"id": "a"}, {"id": "b"}]}
    result = reconcile_requests(
        [{"id": "one", "client_request_id": "a"}, {"id": "two", "client_request_id": "a"}], native
    )
    assert result["status"] == "mismatch"
    assert result["missing_wire"] == ["b"]
    assert result["duplicate_client_ids"] == ["a"]
    assert result["coverage"] == 0.5
    assert reconcile_requests([{"id": "one"}], {"attempts": 1})["coverage"] is None


def test_matching_aggregate_cannot_hide_swapped_per_request_usage():
    from synergy_bench.native_usage import reconcile_requests

    def row(identity, tokens):
        return {
            "id": identity,
            "client_request_id": identity,
            "protocol": "chat-completions",
            "status": "completed",
            "usage": {"prompt_tokens": tokens, "completion_tokens": 1},
        }

    result = reconcile_requests(
        [row("a", 10), row("b", 20)], {"source": "native-transport-pi", "records": [row("a", 20), row("b", 10)]}
    )
    assert result["status"] == "mismatch"
    assert result["usage_mismatches"] == ["a", "b"]


def test_cache_and_reasoning_are_subsets_not_extra_tokens():
    usage = normalize_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 30,
            "prompt_tokens_details": {"cached_tokens": 40},
            "completion_tokens_details": {"reasoning_tokens": 20},
        },
        "chat-completions",
    )
    assert usage == {"input": 100, "output": 30, "total": 130, "cacheRead": 40, "cacheWrite": None, "reasoning": 20}
    assert normalize_usage({"input": 60, "cacheRead": 40, "cacheWrite": 0, "output": 30}, "pi")["input"] == 100


def test_unknown_and_invalid_fields_are_not_converted_to_zero():
    unknown = normalize_usage({}, "responses")
    assert all(value is None for value in unknown.values())
    assert normalize_usage({"input_tokens": -1, "output_tokens": 20}, "responses")["input"] is None
    assert normalize_usage({"input_tokens": True}, "responses")["input"] is None
    assert (
        normalize_usage({"input_tokens": 10, "input_tokens_details": {"cached_tokens": 11}}, "responses")["cacheRead"]
        is None
    )


def test_all_attempts_are_counted_and_duplicate_ids_are_reconciled():
    records = [
        {"id": "a", "status": "started", "usage": None, "protocol": "responses"},
        {
            "id": "a",
            "status": "completed",
            "usage": {"input_tokens": 100, "output_tokens": 30},
            "protocol": "responses",
        },
        {"id": "b", "status": "interrupted", "usage": None, "protocol": "responses"},
    ]
    result = aggregate_usage(records)
    assert result["attempts"] == 2
    assert result["tokens"]["total"] == {"known": 130, "unknown": 1, "total": None}
    assert result["tokens"]["cacheRead"]["unknown"] == 2


def test_late_usage_can_complete_interrupted_attempt_without_double_counting():
    records = [
        {"id": "a", "status": "interrupted", "usage": None, "protocol": "chat-completions"},
        {
            "id": "a",
            "status": "interrupted",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            "protocol": "chat-completions",
        },
    ]
    assert aggregate_usage(records)["tokens"]["total"] == {"known": 12, "unknown": 0, "total": 12}


def test_partial_input_is_a_known_total_lower_bound():
    result = aggregate_usage([{"id": "partial", "protocol": "chat-completions", "usage": {"prompt_tokens": 42}}])
    assert result["tokens"]["total"] == {"known": 42, "unknown": 1, "total": None}


def test_pi_cache_write_is_included_once_in_input():
    value = normalize_usage({"input": 10, "cacheRead": 20, "cacheWrite": 30, "output": 4}, "pi")
    assert value["cacheWrite"] == 30
    assert value["input"] == 60
    assert value["total"] == 64


def test_public_synergy_rollout_matches_calls_without_replacing_accounting(tmp_path):
    import hashlib
    import json
    import zipfile

    from synergy_bench.native_usage import attach_synergy_requests, reconcile_requests
    from synergy_bench.storage import digest

    request = {"model": "fixture", "messages": [{"role": "user", "content": "hello"}]}
    body = json.dumps(request).encode()
    manifest = {
        "format": "synergy-rollout",
        "version": 1,
        "artifacts": [
            {
                "ref": {"id": "body", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()},
                "files": ["request.bin"],
            }
        ],
        "snapshots": [
            {
                "calls": [{"id": "call", "purpose": "compaction"}],
                "attempts": [
                    {
                        "id": "native",
                        "callID": "call",
                        "status": "completed",
                        "url": "http://fixture/v1/chat/completions",
                        "request": {"id": "body"},
                        "usage": {"raw": {"prompt_tokens": 12, "completion_tokens": 3}},
                    }
                ],
            }
        ],
    }
    with zipfile.ZipFile(tmp_path / "rollout.zip", "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("request.bin", body)
    original = {"calls": 1, "tokens": {"total": {"total": 15, "known": 15, "unknown": 0}}}
    enriched = attach_synergy_requests(tmp_path, original)
    assert original == {"calls": 1, "tokens": {"total": {"total": 15, "known": 15, "unknown": 0}}}
    assert enriched["request_records"][0]["purpose"] == "compaction"
    wire = [
        {
            "id": "wire",
            "status": "completed",
            "request_digest": digest(request),
            "protocol": "chat-completions",
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
        }
    ]
    result = reconcile_requests(wire, enriched)
    assert result["mode"] == "request_body_digest"
    assert result["coverage"] == 1 and result["status"] == "matched"
    assert reconcile_requests(wire * 2, enriched)["status"] == "partial"

    manifest["snapshots"][0]["attempts"][0]["responseHeaders"] = {"x-request-id": "synergy-benchmark:wire"}
    with zipfile.ZipFile(tmp_path / "rollout.zip", "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("request.bin", body)
    enriched = attach_synergy_requests(tmp_path, original)
    assert enriched["request_records"][0]["response_request_id"] == "synergy-benchmark:wire"
    result = reconcile_requests(wire, enriched)
    assert result["mode"] == "response_id"
    assert result["coverage"] == 1 and result["status"] == "matched"


def repeated_synergy_requests():
    wire = [
        {
            "id": identity,
            "request_digest": "identical-body",
            "protocol": "chat-completions",
            "status": "completed",
            "usage": {"prompt_tokens": tokens, "completion_tokens": 1},
        }
        for identity, tokens in [("one", 10), ("two", 20), ("three", 30)]
    ]
    native = {
        "source": "synergy-rollout-v1",
        "request_records": [
            {**row, "id": "native-" + row["id"], "response_request_id": "synergy-benchmark:" + row["id"]}
            for row in reversed(wire)
        ],
    }
    return wire, native


def test_response_ids_disambiguate_repeated_bodies_and_reconcile_each_usage():
    from synergy_bench.native_usage import reconcile_requests

    wire, native = repeated_synergy_requests()
    result = reconcile_requests(wire, native)
    assert result["status"] == "matched" and result["coverage"] == 1
    assert len(result["completed_usage_crosschecked"]) == 3
    native["request_records"][0]["usage"], native["request_records"][1]["usage"] = (
        native["request_records"][1]["usage"],
        native["request_records"][0]["usage"],
    )
    result = reconcile_requests(wire, native)
    assert result["status"] == "mismatch"
    assert len(result["usage_mismatches"]) == 2


def test_response_ids_cannot_mask_changed_bodies_missing_or_duplicate_records():
    from synergy_bench.native_usage import reconcile_requests

    wire, native = repeated_synergy_requests()
    native["request_records"][0]["request_digest"] = "different-body"
    result = reconcile_requests(wire, native)
    assert result["status"] == "mismatch"
    assert result["request_body_mismatches"] == ["synergy-benchmark:three"]
    assert len(result["completed_usage_crosschecked"]) == 2
    assert result["coverage"] == 2 / 3

    native["request_records"][0]["request_digest"] = None
    result = reconcile_requests(wire, native)
    assert result["status"] == "partial" and result["coverage"] == 2 / 3
    assert result["unverified_request_bodies"] == ["synergy-benchmark:three"]
    assert len(result["completed_usage_crosschecked"]) == 2

    wire, native = repeated_synergy_requests()
    native["request_records"][0]["response_request_id"] = "synergy-benchmark:absent"
    assert reconcile_requests(wire, native)["status"] == "mismatch"
    native["request_records"][0]["response_request_id"] = "synergy-benchmark:one"
    result = reconcile_requests(wire, native)
    assert result["status"] == "mismatch"
    assert result["duplicate_response_ids"] == ["synergy-benchmark:one"]


def test_response_identity_keeps_early_cancellation_unknown_and_historical_ambiguity():
    from synergy_bench.native_usage import reconcile_requests

    wire, native = repeated_synergy_requests()
    del native["request_records"][0]["response_request_id"]
    result = reconcile_requests(wire, native)
    assert result["coverage"] == 1 and result["status"] == "matched"
    assert result["body_fallback_matches"] == 1

    native["request_records"][0].update(request_digest=None, status="cancelled", usage=None)
    wire[-1].update(status="interrupted", usage=None)
    result = reconcile_requests(wire, native)
    assert result["status"] == "partial" and result["coverage"] == 2 / 3
    assert len(result["completed_usage_crosschecked"]) == 2
    assert result["unidentified_native_requests"] == 1

    wire, native = repeated_synergy_requests()
    for row in native["request_records"]:
        del row["response_request_id"]
    result = reconcile_requests(wire, native)
    assert result["mode"] == "request_body_digest"
    assert result["status"] == "partial" and result["coverage"] == 0
    assert result["ambiguous_request_bodies"] == ["identical-body"]


def test_codex_response_usage_is_crosschecked_per_call_without_counting_duplicate_events(tmp_path):
    import json

    from synergy_bench.native_usage import native_accounting, reconcile_requests

    session = tmp_path / "home/codex/sessions/run.jsonl"
    session.parent.mkdir(parents=True)
    rows = [
        {
            "ordinal": i,
            "type": "token_usage_record",
            "payload": {"response_id": identity, "usage": {"input_tokens": tokens, "output_tokens": 1}},
        }
        for i, (identity, tokens) in enumerate([("response-a", 10), ("response-b", 20)])
    ]
    session.write_text("\n".join(json.dumps(row) for row in [*rows, rows[-1]]))
    native = native_accounting(tmp_path, "codex")
    assert native["tokens"]["total"]["total"] == 32
    wire = [
        {
            "id": str(i),
            "downstream_response_id": identity,
            "status": "completed",
            "protocol": "responses",
            "usage": {"input_tokens": tokens, "output_tokens": 1},
        }
        for i, (identity, tokens) in enumerate([("response-a", 20), ("response-b", 10)])
    ]
    result = reconcile_requests(wire, native)
    assert result["mode"] == "response_id"
    assert result["status"] == "mismatch"
    assert len(result["usage_mismatches"]) == 2
    wire[0]["usage"]["input_tokens"] = 10
    wire[1]["usage"]["input_tokens"] = 20
    wire.append({"id": "interrupted", "protocol": "responses", "status": "interrupted", "usage": None})
    result = reconcile_requests(wire, native)
    assert result["status"] == "partial"
    assert len(result["completed_usage_crosschecked"]) == 2
    assert result["coverage"] == 2 / 3
    historical = [{key: value for key, value in row.items() if key != "downstream_response_id"} for row in wire]
    result = reconcile_requests(historical, native)
    assert result["status"] == "partial"
    assert result["coverage"] == 0
