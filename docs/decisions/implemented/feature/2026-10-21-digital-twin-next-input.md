# Decision Record: Optional personalized next-input suggestions

Status: implemented

## Problem

A useful continuation must respect the completed task and the author's actual phrasing. Generating generic next steps or treating quoted and machine-assisted messages as authentic voice can produce misleading suggestions and feedback loops.

## Decision

Digital Twin is an optional component with its own configuration, hidden Agent, evidence selection and derived projections. Harness supplies versioned completed-context snapshots and canonical corpus access. The component uses an independent recorded `AgentCall` operation with an explicit model and schema-only output; it creates no conversation or executable tools. Full selects the component, while core has no registration, preparation or product controls.

The generic schema-only call supports `outputTool.force: false` for reasoning providers that accept automatic tool selection but reject a forced tool name. Digital Twin uses that selection mode, instructs the model to return the schema tool, and validates exactly one grounded output. The selected model and thinking behavior remain intact; no domain executor is attached.

The output schema enumerates the supplied evidence IDs. Preflight uses the public model input-capacity contract; output follows the selected model and the ordinary provider boundary without a feature-specific token ceiling. An unavailable or oversized context fails explicitly.

Inference and independent evaluation share a native-message projection. It preserves media and complete tool-call/result neighborhoods, masks textual secrets and removes source-provider continuation state. Historical system text and readable assistant reasoning are quoted as data, so provider-specific reasoning replay does not change the observed context. The shared Harness prompt budgeter measures native media, while retrieval and grounding use a textual view that excludes encoded bytes. This avoids mistaking media transport size for model language capacity without truncating genuine conversation text.

Preparation starts on use and checkpoints short batches through the shared background-work controls. Session projections contain numeric language/style observations and versioned representative references. Original human utterances and immediate assistant-to-human continuations are separate evidence channels. The current task has priority; assisted inputs, attributed external text, quoted artifacts and secrets are excluded from positive voice conditioning. Existing text projections perform retrieval without another transcript store. Selected versions are rechecked after inference; unrelated preparation progress cannot invalidate a request.

Ranked retrieval uses the shared CJK/ASCII term index before limiting candidates, groups chunks by message and breaks relevance ties by stable owner/message identity. Literal search remains available during deferred lexical indexing. A Runtime-owned cache loads small Session projections in background pages and replaces them incrementally; warm prediction never scans every projection or transcript. Canonical source events invalidate affected cache entries and in-flight statistics, while ordinary backfill does not. Production and temporal evaluation share evidence scoring, family selection and representative budgets; immutable-history exclusions remain explicit evidence gaps.

The composer consumes successful root-completion events, fences connection, task, model, source and draft changes, and renders the existing editable completion. Tab inserts and Escape dismisses; submission remains a separate user action. Manual prediction works with automatic prediction disabled. Settings contains only automatic prediction and model selection, defaulting to automatic and the current Session model. Generic assistance metadata survives draft persistence, editing and submission without changing message ownership or origin. Clipboard insertions use the same provenance record to keep imported text out of authentic voice examples.

Offline evaluation compares context, voice and full evidence using identical generation settings. Immutable execution records establish temporal cutoffs and authentic held-out inputs; unavailable historical versions are exclusions. Independent blinded scoring measures content, voice, abstention, evidence coverage and uncertainty. Quality targets are acceptance criteria for measured reports, never claims derived from unit tests.

Reports retain separate denominators for predictable coverage, ambiguous abstention, emitted content and voice quality, and failures for each recipe. Successful and failed latency distributions remain separate; actual provider timing and nullable usage/cache fields preserve unknown measurements. Recorded requests retain masked operation source metadata through the generic AgentTurn boundary.

Predictability labels are frozen without candidates. Terminal replies must remain identical in the following immutable request. Each dispatched recipe retains its original result or interruption; errors cannot count as correct abstentions. Corpus, implementation and model configuration identify a frozen experiment. Session-family resampling preserves within-conversation dependence; the interval is widened using [Hoeffding's bounded-variable inequality](https://doi.org/10.1080/01621459.1963.10500830) to prevent tiny all-win samples from implying certainty. This retains the assumption of independent families and does not prove generalization to future behavior.

Message and part identities in immutable context provenance locate the held-out input exactly; missing or ambiguous mappings are exclusions. Atomic checkpoints retain selected evidence before dispatch and operation/call identities as calls begin, including failures. Interrupted calls are never replaced silently; missing usage remains unknown. Acceptance requires all planned cases to finish, so a favorable prefix cannot satisfy the quality gate.

## Alternatives considered

**A generated personality profile.** A prose profile can invent identity facts and lag changing preferences; versioned examples and numeric observations retain inspectable evidence.

**Session-owned prediction turns.** These pollute task history and can interfere with foreground status. Operation ownership retains cancellation and recording without those effects.

**A separate search or training database.** It duplicates canonical history and its invalidation rules. The existing text projection and source revisions provide one authority.

## Consequences

Suggestions remain optional and editable, and removal leaves ordinary messages readable. Historical preparation has a cold cost, including one-time discovery reads for legacy parts without summaries; warm inference hydrates selected examples only. Provenance exclusions are conservative and cannot recover authorship that older records never retained. Temporal evaluation must report insufficient evidence or failed quality targets explicitly, and user resemblance remains an empirical judgment.

Native completion survives refocusing the unchanged caret so the manual button can return to Tab acceptance; moving the caret still dismisses it, and Escape dismisses explicitly without changing the draft. Empty-editor ranges are anchored inside the editable element so completion insertion preserves native undo.

The Runtime publishes representative selections from background preparation and cache replacement; prediction only reads that bundle. First use resumes pending preparation, then reconciles all owner metadata once to catch mutations made while the component was absent. Both cache loading and preparation honor the shared pause gate. Temporal retrieval budgets raw ordinary-text messages before eligibility filtering and uses the same fragment tokenization and identity ordering as the canonical index. Immutable native request provenance supplies conservative observation times and message versions; incomplete observations publish an unavailable version that fences older text until a complete observation restores it, and unobserved membership, deletion and rollback remain explicit catalog gaps. Quality conclusions apply to reconstructable history, not unobserved live-corpus membership.
