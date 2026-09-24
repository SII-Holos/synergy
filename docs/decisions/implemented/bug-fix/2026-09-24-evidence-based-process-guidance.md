# Decision Record: Choose process waits by dependencies and evidence

Status: implemented

## Problem

The [completed waiting study](../../../research/context-efficiency/2026-09-24-process-waiting-followup.md) shows that fewer model polls do not guarantee progress. A command awaited interactive input behind redirected output while the agent repeatedly used long waits. The local and remote background results also suggest status checks without explaining their purpose, unlike the conditional waiting rule in the static descriptions. Trailing diagnostic commands can hide the primary operation's failed shell status.

## Decision

Bash, process and synergy-max guidance separates useful independent work, dependency-gated completion waits, service readiness and targeted diagnosis. A running process is alive, not necessarily progressing. Explicit input requests or unexplained silence where interaction or a stalled dependency is plausible justify inspecting existing output or process state; confirmed quiet work can keep waiting. The initial diagnostic is purposeful rather than a periodic polling requirement.

Unattended commands use supported non-interactive options or known, authorized inputs. Script tasks use script entry points, diagnostic output remains accessible, and compound commands preserve the primary exit status. The guidance names no package manager, benchmark task or expected solution. It does not infer process states, synthesize answers, close stdin or automatically kill/retry work. Local and remote background-result hints give the same conditional choices while preserving result fields, process ownership, defaults and deadlines. Existing Agenda notifications and visible-subtask guards remain unchanged.

This refines the [conditional wait guidance](2026-09-24-process-waiting-guidance.md) without making either blocking or non-blocking a universal preference. Tool descriptions own parameters; the primary prompt owns the decision principle. The tool's 300-second local example is a possible wait window, not a requirement or execution timeout.

## Alternatives considered

**Always block or always inspect output first.** Either can serialize independent work or replace productive waiting with repeated observations. The dependency and evidence determine the next action.

**Detect input waits or kill silent processes automatically.** Process liveness and lack of output do not distinguish computation, input, locks and network delays. These runtime changes require separate evidence and are unnecessary to express the intended behavior.

**Teach the observed task's installation and repair sequence.** That would overfit a general-purpose tool to a measured task and contaminate the next evaluation. Instructions remain applicable to installations, data processing, scripts and services.

## Consequences

Execution mechanics remain unchanged; free lifecycle and remote timeout tests establish that the choices are usable, not that a model chooses correctly. Formal task evidence must distinguish productive waiting, hidden input, command recovery and independent work, retaining actual tests, usage and resource conditions. README concepts and public APIs remain unchanged; generated tool documentation follows the authoritative descriptions.

The [completed two-task study](../../../research/context-efficiency/2026-09-24-general-guidance-study.md) retains passing native tests while observing supported noninteractive installation and useful work during a background operation. It also retains diagnostic commands that mask primary failures. Prompt guidance improves available choices without enforcing them; joint catalog changes, single samples and historical resource differences prevent attributing the complete token or time reduction to this decision.
