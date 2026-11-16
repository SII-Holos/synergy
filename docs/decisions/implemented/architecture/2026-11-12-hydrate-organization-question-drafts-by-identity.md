# Decision Record: Hydrate organization question drafts by identity

Status: implemented

## Problem

A project-wide question draft record loads every saved answer and rewrites the collection while editing one question. Large unresolved queues make that record an unbounded body owner. Organization pending pages are incomplete, so their absence cannot justify deleting unseen drafts. A stored password answer must not become ordinary text through an unknown step policy.

## Decision

Store organization drafts individually in IndexedDB, keyed by the canonical connection, account, project, source Session and native question. Retain each step's input policy with its persisted value. Persist ordinary steps only; password and unclassified steps contain no answer. Restore against both the saved policy and the current native question. The draft key has no invented root lineage: the previous producer knew only the project and exact source/question identity. Submitted logical responses retain their separate complete root/source command binding.

The shared question model accepts a persistence port. Organization consumers use the point owner; personal v1 consumers retain their existing owner and complete-snapshot cleanup. Hydrate the active question only, fence obsolete replies and lock editing until restoration completes. Queue labels read prompt metadata or an already resident step, without opening cold answer bodies. Saved-answer failures offer an explicit retry through the same shared question editor.

Coalesce pending edits to their latest value while a point save is in flight. Wait for the previous ordinary answer's durable save before loading another body. Owner cancellation releases password input immediately; captured ordinary writes drain before their store closes. Explicit native resolution cancels queued edits and removes the point record after any in-flight write. A failed replacement cannot resurrect a resolved draft. Failed removals retain only their exact source/question identity for retry; explicit retry and the next hydration attempt issue the pending deletion again. Disposal waits for in-flight removal and retries pending cleanup before closing its store.

The new owner upgrades the exact previous `Persist.scopeKey` project record once. Validate its account before reading legacy content. Import all source/question entries and a versioned completion receipt in one transaction; remove the old key only after that transaction commits. Failed imports preserve the original record. A committed receipt prevents another parse even if old-key cleanup fails. Steady-state reads and writes use only the point store. Explicit connection sign-out closes its owned producers and removes that connection's records and receipts without reading unrelated bodies.

## Alternatives considered

**Keep the project-wide record with a smaller displayed queue.** The display budget does not bound the saved bodies loaded or rewritten by that record.

**Create the point store without upgrading the previous producer.** A local user may have run the earlier version within this pull request. Its known ordinary drafts remain owned data.

**Infer text input from missing policy or infer a root from the currently open conversation.** Neither fact existed in the old record. Importing one would misclassify data or change its owner.

**Preload saved answers to label every queued request.** This recreates the cold-body ownership problem before a user opens a question.

## Consequences

Active editing and transfer backpressure retain a small working set independently of total saved question count. The one-time upgrade may parse the former complete project record; this is separate from steady-state residency. Storage failure can delay restoration or switching questions while the original data remains available for retry. A cleanup failure can leave the obsolete legacy key until it can be removed, while the receipt keeps that key outside the active read path. Personal offline v1 drafts retain their existing classification limitations. This change does not alter native first-winner authority or the [logical response recovery contract](2026-11-11-reconcile-organization-decisions-with-native-winners.md).
