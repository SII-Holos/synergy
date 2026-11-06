# Design for agent decisions

Start with the decision the model must make: what outcome is required, what is known, which action is available, and what evidence determines the next step. Keep information that changes those decisions. Remove development history, implementation narration and repeated protocol explanations that do not.

## Assign one owner

| Surface                     | Information it owns                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| System or role instructions | Identity, judgment, scope, completion standards and shared interpretation rules             |
| Discovery description       | Enough purpose and exclusions to choose a capability before loading it                      |
| Tool description and schema | Invocation, input relationships, authority, effects and result handling                     |
| Runtime observation         | Relevant facts, source identity, freshness, uncertainty and changes                         |
| Tool result                 | Actual outcome, useful evidence, continuation handle and an actionable next step on failure |
| Skill entry and references  | Selection criteria, common workflow and selectively loaded specialist guidance              |

Review these surfaces together after authorization, optional-component selection and provider preparation. Do not tell the model to read descriptions already in its request. Keep complete Skill selection criteria, including late exclusions; shorten the source rather than cutting away its meaning. Avoid mandatory templates and enumerating routine calls when the model can choose an effective approach.

Internal state is not inherently useful context. Translate it into the consequence for the task: "result unavailable; verify before retrying" instead of explaining event projection or transport recovery. A tool ID, resource ID, offset, version or completion action is appropriate when the model must use it. Keep required workflow termination and review boundaries explicit; do not remove them merely because they name tools.

Put shared interpretation rules once in the effective request and emit changing observations as facts. Preserve the distinction between absent, unavailable, pending and historical information. Authorization, unresolved failures, irreversible effects, untrusted content and uncertainty must survive shortening. Prompts cannot replace enforcement in code.

## Audit and verify

1. Trace a representative request and its continuation through the real preparation boundary. Identify repeated meanings, conflicting instructions, hidden prerequisites and irrelevant implementation vocabulary.
2. Remove or relocate repetition at its owner. Preserve the full original goal through compaction and resumption; do not turn a concise prompt into permission to omit work or lower acceptance standards.
3. Test observable decisions: correct capability selection, valid parameters, recovery from failure, permission denial, cancellation, complete outcomes and truthful limitations. Exact assertions belong to public IDs and necessary contract text, not arbitrary prose snapshots.
4. Verify raw remote contracts and executable schemas independently of curated descriptions. Check changed definitions, partial capability availability and the final model request; a later presentation layer must not overwrite a verified fallback.
5. Use isolated real-model tasks when routing or instruction behavior changes. Report task correctness, requests, tokens and uncached input separately. Character reduction, deterministic fixtures and one successful sample do not prove general model quality or provider-cache savings.
