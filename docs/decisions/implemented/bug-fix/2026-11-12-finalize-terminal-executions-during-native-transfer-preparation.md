# Decision Record: Finalize terminal executions during native transfer preparation

Status: implemented

## Problem

Source owner discovery rejected terminal Native operations awaiting output and checkpoint saving. The strict completed-history reader ran before the source could invoke its already registered drainage and finalization owner. See [the incident](../../../postmortem/0148-terminal-executions-never-reached-transfer-drainage.md).

## Decision

Discovery and publication use the same canonical execution parser and Runtime/Store/artifact/signal-bound iterator. Only discovery permits exited, unsaved or saved records with an original terminal receipt, matching ID, digest and target, fully drained process tree/streams and a saved cursor at or below the receipt. Discovery reads evidence and cannot reconcile, save, release or publish it. Unproven active or unknown operations still block before pause.

The source's native freeze owner remains responsible for final saving through `EnvironmentExecution.drainSession`. After that owner finishes, the frozen transaction rechecks complete operations and released Uses. Export, receiving preparation, installation and binary closure validation retain the original strict completed state and exact cursor checks. No incoming half-saved record becomes portable and no historical operation is replayed.

## Alternatives considered

**Require publication-ready history before preparation.** That prevents the original finalization owner from running.

**Weaken the completed reader globally.** That could publish a receipt before its output and checkpoint exist. The additional state applies only to pure discovery.

**Stop running processes or resubmit a command during discovery.** Discovery cannot grant effects, and an existing operation must settle through its original native identity. Ordinary pause is not a blanket process-kill instruction.

## Consequences

Verifiably ended work can complete its existing save lifecycle during preparation, while active/unknown work remains an explicit blocker. Persisted and wire versions are unchanged. The real Native two-Home fixture performs finalization through Source preparation and preserves original historical data, rollback and corrupt-package refusal. Harness tests separately prove that discovery cannot publish pending-save records or accept unproven completion.
