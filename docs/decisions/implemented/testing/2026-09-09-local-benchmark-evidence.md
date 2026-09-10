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

## Evidence lifecycle

New attempts use result version 2. Execution, verifier reward, export process outcome, archive validation, recording coverage and usage coverage are independent. `evidence.valid` certifies the evidence pipeline; `recording=partial` and unknown usage can accompany a valid cancellation result. Missing referenced artifacts must have explicit missing-evidence declarations, even in partial ZIPs. Export and validation share their own deadline; normal cancellation drains received bytes within the cleanup deadline. ZIP validation reuses `RolloutArchive.inspect()` and binds the report to the actual archive hash.

Resume reconciles terminal evidence before scheduling a new attempt. Recovery export copies the retained Home and writes an independent recovery record without model calls or changes to the original evidence. Locks live outside the removable run directory. Expensive evidence scanning runs on bounded background workers.

Credential presence and references are checked before preparation; actual models and role composition are resolved offline inside the frozen runtime. Temporary credential files are removed before child execution, and values never enter Docker arguments. Source preparation and release staging compile the same pinned Linux watcher patch and verify the native binding.

Unreadable experiment, suite and configuration references and malformed YAML are input errors (exit 2), detected before Docker preparation. A missing custom recipe is likewise an input error in runtime validation. These checks do not reclassify execution, storage or export failures as configuration mistakes.

### Verifier lifecycle ownership

Pier 0.3.1 includes separate-verifier container cleanup inside its verifier timeout and retries that timeout. `BenchmarkTrial` owns this narrow integration boundary: original verifier setup/execution deadlines remain, rewards commit before cleanup, and timeouts are not regraded. The adapter retains Pier's environment, artifact and verifier implementations; its derived code and license are attributed in `benchmark/third_party/pier/`. Cleanup has a separate deadline and a final ownership audit. Future Pier upgrades must pass the behavioral verifier lifecycle and Docker tests before removing or changing this boundary.

Terminal reconciliation also examines retained execution records and incremental CLI terminal events when aggregate evidence is absent. A host crash after model completion must not become another paid attempt; reconstructed evidence records its origin while retaining missing verifier/export/accounting issues. A completed schedule entry without any terminal evidence fails closed.

Native accounting is populated through Pier's post-download hook, after mounted logs have been handed back to the host. The adapter must not read container-owned private files from `run()` cleanup. Active fault-injection observers read within the verified owned container, preserving mode-0600 files and mode-0700 ledger directories on Linux.

Recovery export runs against its private copy, then hands that copy and its output back to the host UID/GID before the container exits. Export failures preserve their exit status through the handoff, and ownership failures remain recovery failures. Permissions stay private; original evidence is never chowned or rewritten.
