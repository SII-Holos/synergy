import copy
import hashlib
import io
import json
import tarfile
import zipfile

import pytest

from synergy_bench.native_usage import reconcile_requests, reconcile_usage
from synergy_bench.storage import atomic_json, digest
from synergy_bench.usage import aggregate_usage


def fixture(tmp_path, *, transport=False, interrupted=False, empty_cancel=False):
    from synergy_bench.evidence import collect_evidence
    from synergy_bench.native_usage import attach_synergy_requests
    from synergy_bench.runner import seal_attempt

    trial = tmp_path / "native"
    wire, native = [], []
    body = {"model": "fixture", "messages": [{"role": "user", "content": "same request"}]}
    calls, attempts, artifacts = [], [], []
    archive = trial / ("agent/rollout.tar.gz" if transport else "agent/rollout.zip")
    archive.parent.mkdir(parents=True)
    for index in range(2):
        usage = {
            "prompt_tokens": 10 + index,
            "completion_tokens": 2,
            "total_tokens": 12 + index,
            "prompt_tokens_details": {"cached_tokens": 4},
        }
        row = {
            "id": str(index),
            "client_request_id": "legacy-" + str(index),
            "request_digest": digest(body),
            "status": "completed",
            "ended_at": 1,
            "protocol": "chat-completions",
            "usage": usage,
        }
        if interrupted and index == 1:
            row.update(status="interrupted", usage=None)
        wire.append(row)
        atomic_json(tmp_path / "wire" / str(index) / "request.json", row)
        atomic_json(tmp_path / "wire" / str(index) / "downstream.json", body)
        native.append({**row, "id": row["client_request_id"]})
        call_id = "call-" + str(index)
        calls.append({"id": call_id, "purpose": "fixture"})
        content = json.dumps(body).encode()
        ref = {"id": str(index), "bytes": len(content), "chunks": 1, "sha256": hashlib.sha256(content).hexdigest()}
        artifacts.append({"ref": ref, "files": [str(index) + ".json"]})
        attempts.append(
            {
                "id": "native-" + str(index),
                "callID": call_id,
                "request": ref,
                "url": "http://fixture/v1/chat/completions",
                "started": 0,
                "ended": 1,
                "status": row["status"],
                "responseHeaders": {"x-request-id": "synergy-benchmark:" + str(index)},
                "usage": {"raw": row["usage"]} if row["usage"] else None,
            }
        )
    if transport:
        with tarfile.open(archive, "w:gz") as output:
            home = tarfile.TarInfo("home")
            home.type = tarfile.DIRTYPE
            output.addfile(home)
            values = {"events.jsonl": b"", "stderr.log": b"", "execution.json": b"{}"}
            for row in native:
                row.pop("request_digest")
                values[f"home/native-wire/{row['id']}/request.json"] = json.dumps(row).encode()
                values[f"home/native-wire/{row['id']}/body.json"] = json.dumps(body).encode()
            for name, value in values.items():
                member = tarfile.TarInfo(name)
                member.size = len(value)
                output.addfile(member, io.BytesIO(value))
    else:
        if empty_cancel:
            ref = {"id": "empty", "bytes": 0, "chunks": 0, "sha256": None, "status": "partial"}
            artifacts.append({"ref": ref, "files": []})
            calls.append({"id": "empty", "status": "cancelled", "transportCaptured": False, "sdkUsage": None})
            attempts.append(
                {
                    "id": "empty",
                    "callID": "empty",
                    "request": ref,
                    "status": "cancelled",
                    "started": 0,
                    "ended": 1,
                    "url": "http://fixture/v1/chat/completions",
                }
            )
        with zipfile.ZipFile(archive, "w") as output:
            for index in range(2):
                output.writestr(str(index) + ".json", json.dumps(body))
            output.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format": "synergy-rollout",
                        "version": 1,
                        "artifacts": artifacts,
                        "snapshots": [{"calls": calls, "attempts": attempts}],
                    }
                ),
            )
        native = attach_synergy_requests(trial / "agent", {})["request_records"]
    result = collect_evidence(trial, {"verifier_result": {"rewards": {"reward": 0}}})
    result.update(
        trial_directory="native",
        attempt_status="completed",
        execution={"outcome": "completed"},
        infrastructure_error=None,
        evidence={"valid": True, "archive_valid": True, "issues": [], "recording": "complete", "usage": "complete"},
        grading={"execution": "completed", "functional_tests": "started"},
    )
    result["accounting"] = {
        **aggregate_usage(native),
        "source": "native-transport-synergy" if transport else "synergy-rollout-v1",
        "records" if transport else "request_records": native,
    }
    result["wire_usage"] = aggregate_usage(wire)
    result["reconciliation"] = reconcile_usage(result["wire_usage"], result["accounting"])
    result["reconciliation"]["requests"] = reconcile_requests(wire, result["accounting"])
    result["files"] = {
        archive.relative_to(trial).as_posix(): {
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "bytes": archive.stat().st_size,
        }
    }
    seal_attempt(tmp_path, result)
    atomic_json(tmp_path / "evidence.json", result)
    return result, wire


@pytest.mark.parametrize("transport", [False, True])
def test_distinct_identical_requests_and_zero_reward_are_admitted(tmp_path, transport):
    from synergy_bench.admission import admit_attempt

    result, _ = fixture(tmp_path, transport=transport)
    before = (tmp_path / "evidence.json").read_bytes()
    receipt = admit_attempt(tmp_path, result)
    assert receipt["status"] == "passed"
    assert receipt["completed_usage_crosschecked"] == 2
    assert (tmp_path / "evidence.json").read_bytes() == before


@pytest.mark.parametrize("transport", [False, True])
def test_interrupted_usage_remains_unknown(tmp_path, transport):
    from synergy_bench.admission import admit_attempt

    result, _ = fixture(tmp_path, transport=transport, interrupted=True)
    receipt = admit_attempt(tmp_path, result)
    assert receipt["completed_usage_crosschecked"] == 1
    assert receipt["unknown_usage_requests"] == 1
    assert receipt["exact_total_tokens"] is None
    assert receipt["known_tokens"] == 12


def test_empty_cancellation_preserves_partial_coverage_and_unknown_cost(tmp_path):
    from synergy_bench.admission import admit_attempt

    result, _ = fixture(tmp_path, empty_cancel=True)
    receipt = admit_attempt(tmp_path, result)
    assert receipt["recorded_request_coverage"] == pytest.approx(2 / 3)
    assert receipt["observed_wire_request_coverage"] == 1
    assert receipt["unconfirmed_native_dispatches"] == [
        {"id": "empty", "provider_dispatch": "unconfirmed", "usage": None}
    ]
    assert receipt["exact_total_tokens"] is None
    assert result["reconciliation"]["requests"]["coverage"] == pytest.approx(2 / 3)


def test_native_deadline_keeps_zero_reward_but_operator_cancellation_stops(tmp_path):
    from synergy_bench.admission import admit_attempt

    result, _ = fixture(tmp_path, interrupted=True)
    result["execution"].update(outcome="timeout", timed_out=True, interrupted=False)
    assert admit_attempt(tmp_path, result)["status"] == "passed"
    result["execution"].update(outcome="cancelled", interrupted=True)
    with pytest.raises(ValueError):
        admit_attempt(tmp_path, result)


@pytest.mark.parametrize(
    "defect",
    [
        "usage_swap",
        "missing_usage",
        "duplicate_id",
        "body_mismatch",
        "invalid_evidence",
        "cleanup",
        "no_grading",
        "missing_native",
        "invented_usage",
        "nonterminal",
    ],
)
def test_invalid_evidence_stops_admission_without_rewriting_results(tmp_path, defect):
    from synergy_bench.admission import admit_attempt

    result, wire = fixture(tmp_path)
    original = copy.deepcopy(result)
    if defect == "usage_swap":
        rows = result["accounting"]["request_records"]
        rows[0]["usage"], rows[1]["usage"] = rows[1]["usage"], rows[0]["usage"]
    elif defect == "missing_usage":
        result["accounting"]["request_records"][0]["usage"] = None
    elif defect == "duplicate_id":
        result["accounting"]["request_records"][1]["response_request_id"] = "synergy-benchmark:0"
    elif defect == "body_mismatch":
        result["accounting"]["request_records"][0]["request_digest"] = "b" * 64
    elif defect == "invalid_evidence":
        result["evidence"]["valid"] = False
    elif defect == "cleanup":
        result["infrastructure_error"] = {"type": "TimeoutError"}
    elif defect == "no_grading":
        result["grading"]["functional_tests"] = "unknown"
    elif defect == "missing_native":
        result["accounting"]["request_records"].pop()
    elif defect == "invented_usage":
        result["accounting"]["request_records"][0]["status"] = "cancelled"
    else:
        wire[0]["ended_at"] = None
        atomic_json(tmp_path / "wire/0/request.json", wire[0])
    with pytest.raises(ValueError):
        admit_attempt(tmp_path, result)
    assert json.loads((tmp_path / "evidence.json").read_text()) == original
