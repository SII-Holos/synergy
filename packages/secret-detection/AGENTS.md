# Secret Detection

Own the runtime-independent detector contract, shared token patterns, regex detector and offline evaluation. Keep Vault, filesystem access, credentials, model SDKs and session policy outside `src/`.

- Return sorted, non-overlapping UTF-16 spans into the original input. Report incomplete scans explicitly; never turn errors into clean results.
- Keep the regex baseline versioned. Preserve its behavior when moving patterns used by observability and SmartAllow.
- Tests belong in `test/`; synthetic evaluation fixtures belong in `fixtures/`. Never add live credentials or session transcripts.
- Run `bun test`, `bun run typecheck`, `bun run evaluate`, and the root dependency and coverage checks after changes. See [package reference](README.md) for evaluation formats.
