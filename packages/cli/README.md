# Synergy CLI

The core `src/index.ts` entry invokes the single `runCli()` implementation with a local runtime factory. No arguments show core command help. `send` opens an in-process runtime; `send --attach` uses the generated HTTP SDK.

The product runtime invokes the same parser with its runtime factory and additional command metadata. It supplies the existing server, browser, library and other product commands, plus the default server command. CLI command loaders are lazy. Commands absent from an installation fail with a nonzero status and an unavailable-command error.

Runtime factories own initialization and shutdown. The CLI owns argument parsing, terminal presentation, JSON events, cancellation and exit codes. Domain packages own their contributed command implementations.

Run `bun test test/cli/composition.test.ts test/cli/send-rollout.test.ts` for parser composition, remote result/cancellation and exit-code contracts. Use this suite for both core and complete product executables. Build the core executable with `bun script/build.ts --single --skip-install`. Then run the copied-installation smoke with `SYNERGY_TEST_ARTIFACT_BIN=/absolute/path/to/bin/synergy bun test test/cli/artifact.test.ts`; this exercises a local model worker outside the repository using an isolated home.

The same acceptance suite runs against an installed module closure with `SYNERGY_TEST_ARTIFACT_INSTALL=/absolute/path/to/installation bun test test/cli/artifact.test.ts`. It checks model completion, real shell writes and file reads, agent step-limit instructions, timeout and permission recovery, and session/rollout export and import. `send`, `export` and `import` all honor `SYNERGY_CWD` for Scope selection.

`bun run build` compiles workspace modules into `dist/modules`. Use the package-owned `bun script/build.ts --single --skip-install` for a local executable; release tooling selects its target matrix through that same explicit binary entry.
