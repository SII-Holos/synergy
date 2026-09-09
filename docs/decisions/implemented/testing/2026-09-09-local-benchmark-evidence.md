# Decision Record: Local benchmark source and experiment identity

Status: implemented

## Problem

Local agent experiments require paired task execution without coupling the evaluator to the changing source under test. A Git commit alone cannot identify uncommitted algorithm changes, and task completion, verifier reward and evidence completeness describe different outcomes.

## Decision

Keep research tooling under the root benchmark directory. Freeze source content before execution, record evaluator and workload identity independently, and generate deterministic paired variant schedules. Use public runtime composition and existing CLI and rollout operations instead of copying execution or accounting into the evaluator.

## Alternatives considered

Running a mutable checkout lets edits affect a trial after its configuration is recorded. Requiring a commit for every experiment interrupts local research. Putting evaluation inside Harness reverses the dependency between the measured runtime and its surrounding tooling.

## Consequences

Snapshots consume local disk space and require content validation. A source identity does not freeze external model services or establish statistical significance. Task selection and raw evidence remain explicit inputs to later analysis.

## Verification

Behavioral tests verify working-tree changes, deletions, new files, executable bits, symlink confinement, immutable revision snapshots, configuration validation, balanced paired schedules, interrupted evidence retention and cleanup ownership. A deterministic local-provider Docker test executes eight trials across the three runtime compositions and both shared and separate verifier environments, checking real tool execution, reward, cache usage, rollout integrity and idempotent resume. It does not establish results for the official task subset.

## Runtime and workload contracts

The evaluator is a private root workspace with a pinned Python/Pier dependency graph. Runtime recipes compose the public core, Library or full product packages; both the CLI parent and agent worker register the same recipe before configuration locks. Prepared Linux Bun source and dependencies are mounted read-only into fresh original-task environments. Evaluator content, measured source, recipe, installed bundle and task content have separate identities. Recipe dependencies resolve by public package name from the frozen workspace manifests, with explicit links beside the wrapper; they do not depend on root dependency hoisting or require the measured revision to contain the evaluator workspace.

The fixed development suite selects twelve DeepSWE 1.1 tasks and twelve Terminal-Bench 2.1 tasks using metadata strata and seed zero. Original instructions, time limits, artifact collection and verifiers are preserved. The suite does not claim official leaderboard equivalence or calibrated population estimates.

Native CLI results and rollout archives remain the accounting authority. The evaluator records task reward separately from process outcome and archive integrity; it does not convert unknown usage to zero or conflate estimated and reported costs. Resume skips all completed attempts, including failures, and creates a new preserved attempt after interruption. Explicit debug execution is outside the formal paired schedule.

Provenance: [Pier 0.3.1](https://pypi.org/project/datacurve-pier/0.3.1/), [DeepSWE source](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea), [Terminal-Bench source](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b).

Local adaptation: retain Pier task lifecycle and verifier behavior while supplying the Synergy CLI adapter, immutable input receipts, paired schedule and raw evidence storage. The [benchmark guide](../../../../benchmark/README.md) owns configuration, commands, extension and validation procedures.
