# Benchmark Engineering

Own local research orchestration, frozen source inputs, task catalogs, runtime compositions and experiment records here. Product execution, accounting and rollout remain owned by their runtime packages.

- Use public workspace exports. Never duplicate the Synergy CLI parser, agent loop or accounting.
- Keep runner identity separate from the source under test. Never run a mutable checkout during a trial.
- Preserve execution status, verifier reward and recording completeness independently.
- Tests live in `test/`. Use isolated homes and deterministic providers; never use personal credentials in tests.
- Run `uv run --project benchmark pytest benchmark/test`, Python checks, runtime tests and affected repository gates.
- Never overwrite prior trials or silently retry a paid execution. Preserve incomplete evidence.
- Version attempt results; historical experiments are read-only when evaluator or result versions differ. Reconcile durable terminal evidence before rescheduling or cleanup.
- Keep execution, cleanup and export deadlines independent. Validate rollout archives with the product contract and keep structural validity, recording coverage and usage coverage distinct.
- Pass credentials through temporary mode-0600 files outside retained evidence. Never pass their values to Docker arguments or persistent options.
- Run deterministic cancellation, long-stream and Linux watcher tests in the benchmark CI job. Keep live-provider acceptance outside CI.
- `BenchmarkTrial` owns the pinned Pier verifier/cleanup boundary. Preserve source attribution and upgrade it only with deadline, reward-retention and Docker regressions passing. Never let environment cleanup consume verifier time or trigger automatic regrading.
- The current result contract covers single-step tasks. Reject multi-step tasks during preparation instead of overwriting step evidence in shared log paths.
