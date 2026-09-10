# Oryn Repository Maintenance

Oryn runs in this repository's GitHub Actions with the pinned runtime in [setup-oryn](../../.github/actions/setup-oryn/action.yml) and the operator policy in [repositories.json](../../.github/oryn/repositories.json). It uses Synergy's public core with a fresh temporary model home per invocation. Repository decisions remain in docs and tests; no resident service, Library database or reusable model history is deployed.

## Configuration and Access

The GitHub App needs installation on `SII-Holos/synergy` and the private runtime repository `yzxoi/oryn-mini`. Repository secrets are `ORYN_APP_PRIVATE_KEY` and `ORYN_GLM_API_KEY`; `ORYN_APP_CLIENT_ID` is an Actions variable. The source token is Contents-read and scoped to Oryn Mini. Target model jobs receive a read-only GitHub token in the host, and the model subprocess receives no GitHub credentials. Publication runs in a separate job with a fresh installation token.

The model defaults to `oryn/glm-5.3-flash`, the official Zhipu Coding Plan API, max reasoning and image input. Its configured context window is 1,000,000 tokens; this setting is not a capacity benchmark. Optional Actions variables are `ORYN_MODEL`, `ORYN_BASE_URL`, `ORYN_TASK_TIMEOUT_SECONDS` (default 1800) and `ORYN_REQUEST_TIMEOUT_SECONDS` (optional 1–3000 seconds; defaults to the remaining task budget). Keys remain secrets rather than repository files or model prompts.

The App permissions are Contents, Issues and Pull requests read/write, plus Actions, Checks and Commit statuses read. It needs no Workflows, Administration or organization grant. Executable workflows and policy come from the trusted default branch for native events, or the selected workflow commit for manual runs. PR source is inspected in a separate checkout as untrusted evidence.

## Intake and Publication

[Oryn](../../.github/workflows/oryn.yml) accepts Issue/PR events, human comment commands, manual dispatch and a six-hour scan. Enable `ORYN_EVENT_ENABLED`, `ORYN_EVENT_PUBLISH`, `ORYN_ENABLED` and `ORYN_SCHEDULE_PUBLISH` as Actions variables with value `true` for automatic operation. Bot comments bypass planning and the shared publication queue. The queue preserves pending runs and processes at most two items concurrently within a scan of at most 20 items.

Manual dispatch defaults to `preflight=true`, which checks App access and planning without model calls or writes. A selected run with `preflight=false` and `publish=false` produces an artifact for inspection; `publish=true` enables reports and labels. Operational receipts live in GitHub comments and artifacts expire after seven days.

Maintainers can use `@oryn-mini review`, `ask …`, `fix`, `implement issue`, `rebase`, `cluster #N #M`, `autoclose`, `automerge`, `stop` and `resume`. Slash aliases include `/review`, `/autofix`, `/rebase`, `/autoclose` and `/automerge`. A clean review does not itself authorize closure or merge. Those operations require the opted-in capability and a current maintainer command; merges also require independent approval, clean mergeability and the exact-head `All checks passed` result. Release promotion to `main` remains owned by [the release workflow](../../.github/workflows/release.yml).

Source/title/body changes, command edits, revoked command authority and authorized stop commands invalidate a task. Ordinary comments, labels and CI/review progress remain evidence rather than cancellation authority. Publication rechecks current source and authority; merge separately checks live readiness. Protected labels exclude new admissions, while the stop command interrupts active work.

PR context contains statistics and a complete paged file inventory. The model uses Core read tools to inspect per-file diffs and related repository files on demand. Evidence snapshots are outside the candidate checkout and validation home, disappear with the task, and cannot be modified by the model. Incomplete coverage is reported as needs_human; the task deadline and separate repair-publication output limits remain.

Long model requests may use the remaining task budget; first-byte and idle limits remain at most 120 and 60 seconds. Remove a legacy `ORYN_REQUEST_TIMEOUT_SECONDS=300` override to adopt this default. Total task deadlines and authorized cancellation still apply. Failed runs retain a bounded, redacted `diagnostic` in `failure.json` and an `oryn_failure` log event, including Core status, available provider error details, budgets and progress counts. Report format failures include the correction attempt and output size. Raw prompts, reasoning, headers and provider bodies are excluded. An abort without a recorded cause remains explicitly uncertain.

## Repair Verification

The trusted [validation entry](../../.github/oryn/validate.ts) and workspace dependency graph are copied from the workflow checkout into a read-only host location. Selection compares the candidate working tree against the exact job base commit and includes committed, staged, deleted and untracked changes. Repository documentation runs governance gates; package changes select the owning workspace and transitive dependents. Root configuration or unknown executable changes select every workspace.

Validation installs frozen dependencies without lifecycle scripts, runs documentation/decision/Skill checks and selected package typechecks, then invokes package test scripts through Turbo with bounded concurrency. Core suites retain their package isolation orchestrators. The host prepares Chromium for browser fixtures; validation has isolated test and Link homes, no model or GitHub keys, and runs inside Oryn's Linux bubblewrap sandbox. Failed checks or exhausted budgets prevent repair publication. Windows, macOS, installed-runtime and coverage matrices remain CI responsibilities. Independent review checks the complete final patch and consumes the actual validation outcomes before publication.

## Labels and Maintenance

[The label catalog](../../.github/labels.yml) includes Oryn's kind, priority, proof and result-status labels plus `oryn:hold`. Oryn updates only its advisory labels; existing maintainer classifications and priorities remain independent. Legacy emoji-first Oryn type/priority/needs-human labels migrate to matching catalog entries. Legacy in-progress and untriaged labels become `needs-triage` on open items and are removed from closed items, since they do not establish an active runtime receipt.

Upgrade the immutable runtime pin through a PR, run `bun test --config /dev/null test/script/oryn-validation.test.ts` and `bun run workflow:check`, then run a manual preflight and a selected model review. Verify the model run separately from preflight success. Workflow compatibility exceptions are limited to actionlint's unsupported queue key and zizmor's trigger/publish heuristics, with rationale at the owning YAML entries. Keep the existing release route, runtime isolation, App scopes and publication checks when changing the integration.

See [the integration decision](../decisions/implemented/process/2026-09-10-oryn-repository-maintenance.md) for alternatives and trade-offs.
