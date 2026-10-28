# Decision Record: Retain safe released-upgrade baseline protocol evidence

Status: implemented

## Problem

The pinned 3.0.22 upgrade scenario failed its initial exactly-once side-effect check in two Linux CI runs, before starting the candidate. Another failure occurred after restoring the backup and starting 3.0.22 again. The assertion alone cannot distinguish a second model-issued tool call from repeated execution of one call. A faithful macOS baseline passed, while the released Linux executable crashed before startup under local x64 emulation. Neither observation establishes the Linux duplication's cause.

## Decision

The installed acceptance provider offers an optional typed decision observer. It exposes request sequence, a SHA-256 request fingerprint, message roles, selected-user position, tool and result counts, and whether the response emits a tool call. Emitted calls and received results carry matching SHA-256 identity fingerprints. It does not expose messages, commands, paths, credentials, endpoints or runtime identifiers.

The released-upgrade test collects these decisions by runtime phase. An exactly-once assertion failure in any phase reports the expected and actual effect counts, the latest 128 provider decisions and up to 64 persisted messages with 32 tool states each, then rethrows the original assertion error. The persisted evidence preserves parent positions, repeated-call identity fingerprints, process exit codes, allowlisted error codes and bounded error-category hints and causes. These hints classify diagnostic text; they do not establish an execution failure's cause. A successful process exit remains distinct from a later checkpoint or coordination error. The observer does not deduplicate requests, reuse call identifiers or suppress tools. All upgrade, restart and backup-recovery assertions remain unchanged.

## Alternatives considered

**Retry unchanged CI without additional evidence.** Another pass would not explain the observed duplicate side effect.

**Make the fixture command idempotent or suppress repeated requests.** This would hide the behavior the upgrade scenario is meant to reject.

**Publish raw requests or server logs.** These can contain prompt contents, paths and runtime identity. Derived protocol observations distinguish the hypotheses without disclosing those fields.

## Consequences

Opted-in fixture requests add digests and a small in-memory observation; ordinary callers do not collect either. Passing scenarios remain quiet. The HTTP regression verifies correlation, redaction and unchanged responses for repeated requests, completed tools and auxiliary calls. Protocol-summary tests retain repeated call identities, terminal process outcomes and nested failure categories while rejecting payload leakage and bounding retained detail.

This is diagnostic coverage, not a claim that duplication is fixed. Actual Linux execution must establish the cause and validate a subsequent repair; local emulation failure cannot substitute for that evidence.
