# Session interactions amplified global work

## Executive summary

Session navigation and first-message submission stalled because an execution summary scanned installation-wide usage inside a shared reader snapshot. Small fixtures hid that cost, incomplete navigation and HTTP metrics understated it, and a missing-input receipt had no terminal recovery state. Independent snapshot, upgrade and optional-retrieval work amplified the delay. Bound work to its owner, preserve ambiguous acceptance, and measure readiness from the user's action.

## Summary

An existing installation with roughly 9,250 sessions and two million message Parts exposed 102–114 second reader holds. Unrelated foreground reads then hit their 30-second admission deadline. New sessions could exist without an accepted first message while the UI kept confirming the receipt. Project filesystem capture and remote embedding requests delayed otherwise trivial model turns. The full [investigation and measured limits](../research/2026-10-03-session-latency-audit.md) distinguishes the original version, upgraded version and local repairs.

## Timeline

- Initial inspection reproduced slow navigation, new-session loading and a tool pane that recovered after leaving and returning.
- The authorized upgrade exposed a startup metadata validation failure after lengthy historical preparation. A regression isolated a missing catalog endpoint that should use the SDK default.
- Real-data retesting isolated broad usage scans and unrecoverable missing receipts rather than attributing every delay to the model.
- Owner-indexed collection, bounded filesystem concurrency and explicit input recovery restored ordinary interaction. Fault injection then exposed and repaired retry-admission and restored-draft races.
- Final phase spans localized the remaining large-history cost to journal replay; separate model accounting exposed duplicate optional embedding attempts.
- Cold restart verification exposed repeated journal replay and Scope-wide lineage discovery. Persisted presentation checkpoints and a migrated reverse-lineage index removed those repeated scans; bounded workspace reads shortened cold navigation.
- Native UI verification found committed summaries duplicated as running cards in virtual footer segments. Segment-owned body projection and lifecycle-based status removed the false activity.

## Root cause

A filtered API was assumed to perform filtered physical work. Its implementation loaded global counters and repeatedly discovered lineage while serving a selected session. A storage snapshot made those reads consistent but also retained the shared reader long enough to block unrelated tasks. Small isolated fixtures verified output correctness without exposing the installation-scale work.

The frontend conflated unavailable acceptance evidence with confirmed absence. It kept an optimistic message and loading handoff alive after a definitive missing receipt. On recovery, starting observation before retry admission could immediately rediscover absence, while draft revision changes during restoration prevented later cleanup.

Observability omitted navigation before route hydration and replaced numerical HTTP status with span outcome. These defects made slow or failed interactions appear shorter and healthier. Delayed browser metric batches also replaced individual navigation attribution with the current page and filtered known navigation triggers. Per-sample validated attribution now takes precedence, with real-store coverage. Background preparation also reused an expired absolute admission deadline across multiple steps, creating repeated deferrals after a successful but slow first step.

Virtualized presentation shared message metadata across body and footer segments. Treating missing segment-local content as evidence of an active compaction created false running cards for completed summaries. Lifecycle status and body ownership require separate decisions.

A final startup exposed a separate Desktop persistence race: simultaneous skin IPC updates wrote the same process-local temporary filename. Per-target serialization now preserves invocation order and atomic replacement, with explicit cleanup and retry after failures.

## Guardrails added

- [Selected-owner usage and snapshot tests](../../packages/harness/test/usage/ledger.test.ts) protect unrelated damaged records, descendant accounting and multi-page collection; [snapshot capture tests](../../packages/harness/test/snapshot/workspace.test.ts) verify bytes and identity.
- [Receipt recovery tests](../../apps/web/test/components/session/session-input-observer.test.ts), production-UI fault injection and same-identity retry checks distinguish missing, unavailable and accepted-but-lost responses.
- [Navigation timing tests](../../apps/web/test/utils/perf.test.ts) include pre-route work; [HTTP status tests](../../packages/harness/test/observability/http-status.test.ts) preserve error classification.
- [Background preparation tests](../../packages/harness/test/storage/evidence-owner-projection.test.ts) cross a slow first step with later work; [Library contribution tests](../../packages/library/test/context-contribution.test.ts) bound optional recall and preserve always-memory.
- [Rollout projection tests](../../packages/harness/test/session/rollout-projection.test.ts) cover persisted reuse, concurrent append, missing evidence and owner deletion; [compaction DOM tests](../../packages/ui/test/components/session-turn-chronology.dom.test.ts) cover completed, active and failed segmented cards. The [incremental presentation decision](../decisions/implemented/bug-fix/2026-10-03-incremental-execution-presentation.md) records the strict-replay and cache tradeoff.
- The [interaction decision](../decisions/implemented/bug-fix/2026-10-03-session-interaction-latency.md), [runtime recovery decision](../decisions/implemented/bug-fix/2026-10-03-runtime-recovery-evidence.md) and [history-upgrade decision](../decisions/implemented/bug-fix/2026-10-03-demand-driven-history-upgrades.md) retain implementation tradeoffs.

## Lessons

Acceptance, canonical message visibility, model execution and interactive rendering are different milestones. Test them independently, including failures between milestones. Consistent reads must also be bounded; cache warmth and small fixtures do not establish scalability. Preserve raw evidence and unresolved costs: a faster large-history query is still slow, and a fast already-upgraded restart does not prove a fast first upgrade.
