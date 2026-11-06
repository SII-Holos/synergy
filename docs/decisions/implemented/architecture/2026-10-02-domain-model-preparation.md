# Decision Record: Freeze domain state before model generation

Status: implemented

## Problem

Embedded domains need an authoritative observation of editable state for each assistant response. Advisory prompt contributions can fail softly and tool execution occurs after generation; neither establishes the version the model observed.

## Decision

SessionExecutionContributions accepts a prepareModel callback. The Session loop invokes registered callbacks sequentially after persisting the assistant and before prompt preparation or model dispatch. Each callback receives a detached Session snapshot, exact assistant and root identities, Agent name and the owning cancellation signal. Failure stops that assistant step through the existing terminal error path. Cancellation is checked before and after every callback.

## Alternatives considered

**Advisory context callbacks.** They permit fallback and do not carry the persisted assistant identity.

**Tool executor observations.** They can silently adopt a newer version after the model has already proposed an edit.

**Exporting the private resolver.** It exposes generic execution internals to each embedded domain and duplicates orchestration.

## Consequences

Domains own observation contents, idempotency and scoped authorization through this existing Runtime registry. The Core owns ordering and assistant error settlement. An unregistered callback preserves default behavior. The callback does not grant execution permissions or alter tool selection. Independent instances have independent contributions, and registration remains sealed after opening.
