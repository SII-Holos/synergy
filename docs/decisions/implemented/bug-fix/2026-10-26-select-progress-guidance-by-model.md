# Decision Record: Select shared progress guidance by model

Status: implemented

## Problem

Shared progress guidance encourages useful intermediate updates, but a reported DeepSeek task repeatedly restated the same verification status. Removing that encouragement for DeepSeek requires knowing the model used by the request. Primary Agent builders embedded the section before model resolution, while runtime preparation also appended it for prompts without its heading. Gating only the runtime append would leave the primary copies active.

## Decision

`agent/prompt/progress.ts` owns both the unchanged shared section and `withProgressUpdates()`. Primary builders do not inline the section. Native request preparation and external-agent instructions invoke the same selector after model resolution. Final native budgeting reuses the prepared system messages rather than selecting or appending another copy.

The exclusion list contains only `deepseek`. A case-insensitive final slash-delimited component of the model ID, API model ID or family matches when it equals the listed family or starts with that family followed by a hyphen or period. Bedrock inference prefixes (`us.`, `eu.`, `apac.`, `global.`) are removed before matching. This covers recognizable direct models, gateway namespaces, Bedrock IDs and aliases with family metadata without classifying unrelated models by their connection name. An opaque model with no recognizable identity retains ordinary guidance.

External adapters use Session model metadata only when the adapter actually applies that model override. Native authentication, incompatible overrides and unsupported model switching retain the adapter's configured model identity instead. An unspecified adapter default is unknown and retains shared guidance, rather than being misclassified using an unused Session selection.

Exclusion skips only Synergy's shared injection. It does not remove user-written communication instructions, project instructions, memories or historical messages. Existing custom progress headings still prevent duplicate insertion. There is no alternative DeepSeek prompt, output filter, configuration flag or separate provider routing stack. This preserves the single-owner policy from [inject each runtime prompt fact once](../simplification/2026-10-22-inject-each-runtime-prompt-fact-once.md) and the communication intent of [key-moment updates](../simplification/2026-08-27-narrow-agent-preamble-to-key-moments.md).

The misleading `SystemPrompt.provider(_model)` wrapper becomes `SystemPrompt.fallback()`, returning the single minimal prompt string. A native Agent without its own prompt still receives that identity. Model eligibility belongs to the progress selector, not this fallback.

## Alternatives considered

**Keep builder injection and strip the section for excluded models.** This creates two assembly paths and risks deleting user-authored instructions. Selecting once before insertion makes ownership explicit.

**Choose by provider name.** A gateway can serve several model families, and a custom connection can rename DeepSeek. Model identity is the relevant evidence.

**Add a DeepSeek-specific negative prompt or filter intermediate text.** Another prompt variant invites contradictory guidance; output filtering changes visible model behavior and could conceal meaningful findings or consent requests. Neither is needed to stop this shared injection.

## Consequences

Other models retain the exact shared guidance text, appended once during request preparation rather than embedded in a primary template. DeepSeek loses this particular encouragement to report progress, not the ability to communicate. Models and custom instructions may still produce repetitive updates; deterministic injection tests cannot establish improvement in live model output.

The existing Agent prompt tests cover the shared owner, excluded identities and custom-instruction preservation. Session tests inspect prepared system and model messages for all three primary roles across model switches, and preserve fallback/custom content for excluded and eligible models. External tests exercise the real Session invocation path with a registered adapter substitute, checking delivered instructions against applied, ignored and unsupported model overrides. They do not run native Codex or Claude Code processes. The exclusion list is deliberately code-owned and narrow; adding a family requires an explicit change and regression evidence.
