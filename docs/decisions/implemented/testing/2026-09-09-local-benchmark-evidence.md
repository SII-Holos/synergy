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

Behavioral tests verify working-tree changes, deletions, new files, executable bits, symlink confinement, immutable revision snapshots, configuration validation and balanced paired schedules.
