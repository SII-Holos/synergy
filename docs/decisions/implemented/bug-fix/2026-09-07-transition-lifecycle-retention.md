# Decision Record: Release frontend state across Solid transitions

Status: implemented

## Problem

Repeated navigation retained disposed Session owners through the global command registry, including their editor state and detached DOM. SyncProvider also registered its cleanup after returning, leaving Scope stores and message requests alive. Separately, a new Match read during a suspended transition could throw a function-call TypeError in the pinned Solid runtime. These failures need distinct fixes; rendering budgets alone cannot release a reachable page owner.

## Decision

CommandProvider creates reactive command accessors with their page owner but publishes them to the global registry in `onMount`, after transition commit. Owner cleanup removes the registration. Registration remains reactive, newest-registration precedence remains intact, and a pending page cannot replace commands from the visible page.

SyncProvider registers cleanup before returning. Its message loader aborts on disposal, and each provider holds an idempotent Scope lease. Only the last overlapping provider releases the shared Scope state. Background Scopes without leases use an eight-entry LRU budget; viewed Scopes are protected outside that budget. Release clears queued bootstrap work, message-LRU membership, refresh timers, replay tracking, and Scope freshness resources. Bootstrap, resync, replay, and session-list results must still belong to the same Scope store instance before applying. Bootstrap concurrency tracks store identity so an old generation cannot suppress a reopened Scope.

The workspace pins Solid 1.9.15, which includes the upstream [initial transition memo fix](https://github.com/solidjs/solid/pull/2617). The real CompactReasoningLine regression suspends a transition, updates streaming text before commit, and verifies that Match children remain readable. The command retention regression still requires the lifecycle fix independently of this dependency upgrade.

## Alternatives considered

**Upgrade Solid alone.** It fixes the undefined initial memo value but leaves the command registry leak reproducible. The application must publish page registrations at the committed lifecycle boundary.

**Delete Scope state on every provider cleanup.** A transition can mount the replacement before disposing the old provider. Unconditional deletion discards state that the replacement still uses. Shared leases preserve that state until its final consumer leaves.

**Retain every background Scope or rely only on message budgets.** Scopes can retain providers, sessions, volatile resources, and other state without ever mounting a SyncProvider. A separate inactive Scope budget limits this path; existing message and rendering budgets remain necessary within each Scope.

## Consequences

Repeated navigation no longer grows the command registry with disposed pages. A pending transition keeps the visible page's commands until commit. Leaving the final view releases its Scope immediately, so revisiting may require a new bootstrap. The background limit is a count budget, not a bound on total browser bytes; active Scopes, editors, and in-flight requests still consume memory. Old requests may finish, but their results cannot recreate or modify a replacement Scope. Heap recovery in a long-running installed client still requires verification after deploying the fix; deterministic lifecycle tests establish ownership and ordering, not an end-to-end memory ceiling.
