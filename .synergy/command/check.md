Run all quality checks in sequence: typecheck, tests, and format verification.

Execute these commands and report results:

```bash
bun run typecheck
```

If typecheck passes:

```bash
cd packages/synergy && bun test
```

If tests pass:

```bash
./script/format.ts
git diff --exit-code || echo "Formatting changes detected — run ./script/format.ts and commit"
```

Summarize: which checks passed, which failed, and what needs fixing. $ARGUMENTS
