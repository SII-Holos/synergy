# Decision Record: Measure the session-export release through its native CLI

Status: implemented

## Problem

Comparing an optimized candidate with release 3.0.22 requires executing its monolithic source package. That release predates runtime compositions and rollout exports. Applying the current recipe would require changing the measured program or inventing accounting that the release never produced.

## Decision

The evaluator recognizes the audited `v3.0.22` commit `024dd683e091d9fce3d1d26b79b2e188ce636b52` as `synergy-session-v1`. It requires an explicit source revision, uses the pinned Bun and dependencies, and launches the native `send --format json` CLI. The monolith accepts only the full runtime condition; experiment overlays are rejected. Offline inspection uses the release's public model, agent and configuration APIs.

The native Home and CLI events are retained in `native-home-tar-v1`; no current rollout or run-accounting records are fabricated. A neutral fetch observer is preloaded in the CLI and inherited native agent-turn workers, and its per-request records are reconciled with the independent gateway. Process exit and a native terminal event jointly determine completion. Execution, cleanup and export retain separate deadlines.

Provenance: [release source](https://github.com/SII-Holos/synergy/tree/v3.0.22/packages/synergy), particularly `src/cli/cmd/run.ts`, `src/session/agent-turn/process-host.ts` and the public package exports. Local adaptation uses `BUN_OPTIONS=--preload=...`; the equals form is required for inherited `bun run` launches in Bun 1.3.14 and is exercised with actual parent and child processes.

## Alternatives considered

**Backport current rollout support into the release.** Rejected because it changes the baseline's runtime and would obscure which behavior is being compared.

**Count only primary CLI step events.** Rejected because title, intent and child calls can consume tokens without appearing in that stream.

**Accept arbitrary historical layouts.** Rejected because package shape alone does not establish compatible CLI, model selection, cancellation or recording behavior. Other releases require their own audit.

## Consequences

Both sides use one frozen evaluator but different native recording formats. Historical accounting is transport evidence, not a current product rollout. Release-to-candidate results include intervening product changes and cannot attribute all differences to one PR. A changed baseline, output limit or evaluator creates a new experiment; cancelled attempts and unknown usage remain in the cumulative cost report.
