# Decision Record: Shared conversation content recovery

Status: implemented

## Problem

A Part summary can become stale while its body request is in flight. The generated SDK rejects with the server's structured `SessionDisplayConflict` object. Converting that value with `String()` exposes `[object Object]` in the conversation. Row-owned summary refresh also duplicates shared requests, can lose a forced refresh behind a pending page, removes readable bodies during version changes and leaves a failure visible after content recovers.

## Decision

The Scope Part materializer owns recovery and retains one current read per Part across consumers and version advances. It snapshots requested versions, preserves the accepted body and its memory accounting, and applies only current results. Retry patience follows the existing [superseded message snapshot decision](2026-09-18-message-superseded-backoff.md); the current limits and cancellation rules live in [Frontend data sync](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).

The Part summary loader serializes message page requests and coalesces queued recovery requests. A forced refresh follows an older request; a page that already advanced another target satisfies that target's recovery. Anchored refreshes reconcile summaries without replacing retained history or its cursors. Recovery uses the body lease's cancellation signal so releasing one Sync provider cannot cancel another provider's shared content cache.

Conversation rows keep failures per Part and lease. Successful content clears its own failure; obsolete callbacks cannot update the row. Real errors retain string diagnostics under a localized wrapper and a separate retry button. Exhausted conflicts describe content synchronization rather than a failed tool or execution. A removed retry control returns keyboard focus to its retained message row; another control keeps focus if the reader moves there during recovery. The public Plugin conversation content interface and server version guard stay unchanged.

Retry exhaustion limits network work, not adoption of an accepted live checkpoint. The materializer checks the owning Scope's body and version together. A matching body supersedes a pending or failed lease, cancels its obsolete read and settles mounted consumers without another request. Same-version delivery is observable independently of summary changes. Summary-only advances and mismatched bodies preserve the failure and bounded request budget. Acceptance updates memory accounting and publishes body/version atomically, so a concurrent consumer cannot attach a new version to an old body.

Transient error paragraphs do not own conversation reading anchors or saved body-block indices. Automatic capture prefers a visible body paragraph over preceding status-only rows; explicit interaction targets retain ownership. The shared resize observer watches that reading owner as well as the content and viewport, avoiding a painted displacement while virtual content measurements catch up. Reading remains attached to the accepted body when an error appears or clears; row identity alone cannot preserve a paragraph displaced by a removed banner.

## Alternatives considered

**Only format error objects.** This makes the failure readable but still exposes an expected streaming race, duplicates refresh requests and leaves stale error state after successful recovery.

**Retry in each message row.** Rows mount and release independently, so retries would multiply across consumers and lose their budget when a version or disclosure changes. The shared cache owns those lifetimes and requests.

**Remove the server version guard or retry indefinitely.** Removing the guard permits stale bodies to overwrite current content. Unbounded retries keep issuing requests during a sustained stream or persistent failure. Bounded recovery preserves current data and offers an explicit restart.

**Hide errors whenever text is visible.** Retained text can belong to an older version while another required Part is still missing. Only version-matched content establishes successful recovery; task completion and nonempty rendered text do not.

## Consequences

Ordinary content races recover without inserting error text into the transcript, and an update does not flash away accepted content. The cache retains additional retry state and accepted-version metadata; memory accounting still includes the retained body. A sustained conflict can end in a localized retry, and network or permission errors remain actionable failures. Behavioral tests cover the shared cache, page ordering, SDK JSON errors and real virtual conversation rows across activity modes.

Materializer, Sync-provider and browser row regressions exhaust the request budget before delivering same-version and newer checkpoints. They require automatic removal of the stale retry, unchanged row identity, zero additional body requests, rejection of mismatched bodies and late completions, and release of memory after disposal.

Browser reading tests remove a visible error above accepted text, hold the virtual content extent unchanged and restore a saved reading position after removal. Each preserves the body paragraph's viewport offset. Production browser acceptance also checks compositor frames, since an eventual restored offset can conceal a one-frame jump.
