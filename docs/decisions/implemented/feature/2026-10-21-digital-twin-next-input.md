# Decision Record: Optional personalized next-input suggestions

Status: implemented

## Problem

A useful continuation must respect the completed task and the author's actual phrasing. Generating generic next steps or treating quoted and machine-assisted messages as authentic voice can produce misleading suggestions and feedback loops.

## Decision

Digital Twin is an optional component with its own configuration, hidden Agent, evidence selection and derived projections. Harness supplies versioned completed-context snapshots and canonical corpus access. The component uses an independent recorded `AgentCall` operation with an explicit model and schema-only output; it creates no conversation or executable tools. Full selects the component, while core has no registration, preparation or product controls.

Preparation starts on use and checkpoints short batches through the shared background-work controls. Session projections contain numeric language/style observations and versioned representative references. Original human utterances and immediate assistant-to-human continuations are separate evidence channels. The current task has priority; assisted inputs, attributed external text, quoted artifacts and secrets are excluded from positive voice conditioning. Existing text projections perform retrieval without another transcript store. Selected versions are rechecked after inference; unrelated preparation progress cannot invalidate a request.

The composer consumes successful root-completion events, fences connection, task, model, source and draft changes, and renders the existing editable completion. Tab inserts and Escape dismisses; submission remains a separate user action. Manual prediction works with automatic prediction disabled. Settings contains only automatic prediction and model selection, defaulting to automatic and the current Session model. Generic assistance metadata survives draft persistence, editing and submission without changing message ownership or origin. Clipboard insertions use the same provenance record to keep imported text out of authentic voice examples.

Offline evaluation compares context, voice and full evidence using identical generation settings. Immutable execution records establish temporal cutoffs and authentic held-out inputs; unavailable historical versions are exclusions. Independent blinded scoring measures content, voice, abstention, evidence coverage and uncertainty. Quality targets are acceptance criteria for measured reports, never claims derived from unit tests.

## Alternatives considered

**A generated personality profile.** A prose profile can invent identity facts and lag changing preferences; versioned examples and numeric observations retain inspectable evidence.

**Session-owned prediction turns.** These pollute task history and can interfere with foreground status. Operation ownership retains cancellation and recording without those effects.

**A separate search or training database.** It duplicates canonical history and its invalidation rules. The existing text projection and source revisions provide one authority.

## Consequences

Suggestions remain optional and editable, and removal leaves ordinary messages readable. Historical preparation has a cold cost, including one-time discovery reads for legacy parts without summaries; warm inference hydrates selected examples only. Provenance exclusions are conservative and cannot recover authorship that older records never retained. Temporal evaluation must report insufficient evidence or failed quality targets explicitly, and user resemblance remains an empirical judgment.
