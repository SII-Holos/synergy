# Decision Record: Retain safe released-upgrade baseline protocol evidence

Status: implemented

## Problem

The pinned 3.0.22 upgrade scenario failed its initial exactly-once side-effect check in two Linux CI runs, before starting the candidate. The assertion alone cannot distinguish a second model-issued tool call from repeated execution of one call. A faithful macOS baseline passed, while the released Linux executable crashed before startup under local x64 emulation. Neither observation establishes the Linux duplication's cause.

## Decision

The installed acceptance provider offers an optional typed decision observer. It exposes request sequence, a SHA-256 request fingerprint, message roles, selected-user position, tool and result counts, and whether the response emits a tool call. It does not expose messages, commands, paths, credentials, endpoints or runtime identifiers.

The released-upgrade test collects these decisions. Only when the original baseline assertion fails, it reports them alongside persisted message roles, error-presence flags and tool states, then rethrows the original assertion error. The observer does not deduplicate requests, reuse call identifiers or suppress tools. All upgrade, restart and backup-recovery assertions remain unchanged.

## Alternatives considered

**Retry unchanged CI without additional evidence.** Another pass would not explain the observed duplicate side effect.

**Make the fixture command idempotent or suppress repeated requests.** This would hide the behavior the upgrade scenario is meant to reject.

**Publish raw requests or server logs.** These can contain prompt contents, paths and runtime identity. Derived protocol observations distinguish the hypotheses without disclosing those fields.

## Consequences

Opted-in fixture requests add a digest and a small in-memory observation; ordinary callers do not collect either. Passing scenarios remain quiet. The HTTP regression verifies redaction and unchanged responses for repeated requests, completed tools and auxiliary calls.

This is diagnostic coverage, not a claim that duplication is fixed. Actual Linux execution must establish the cause and validate a subsequent repair; local emulation failure cannot substitute for that evidence.
