Verify the current Synergy changes from narrow checks to repository gates. Interpret `$ARGUMENTS` as a requested scope or additional check.

1. Inspect `git diff --stat` and select the affected package/domain tests.
2. Run the narrow test first. Core runtime tests run from `packages/synergy`.
3. Run the default root preflight:

```bash
bun run quality:quick
```

4. Run `bun run quality` when the change crosses shared abstractions, the user requests the full suite, or the work is ready for PR-level verification.
5. Add specialized checks when relevant:

```bash
bun run deadcode
bun run workflow:check
bun run secrets:check
bun run desktop:test
```

Do not use root `bun test`; it intentionally fails. Do not bypass hooks or weaken tests. Report each command, pass/fail counts, causal failure, fixes made, rerun result, and checks not run.

$ARGUMENTS
