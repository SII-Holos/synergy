Run all quality checks and report results.

1. Run the full quality preflight:

```bash
bun run quality:quick
```

2. If that passes, run the full quality suite with tests:

```bash
bun run quality
```

3. Run individual checks as needed:

```bash
bun run format:check       # check formatting with prettier
bun run lint                # lint with oxlint
bun run typecheck           # type-check all packages via turbo
bun run deadcode            # check dead code and dependency hygiene (knip)
bun run monorepo:check      # validate monorepo dependency consistency (sherif)
bun run workflow:check      # validate CI workflow files (actionlint)
bun run secrets:check       # scan for secrets (gitleaks)
bun run package:check       # validate publishable packages (publint + attw)
cd packages/synergy && bun test  # run test suite
```

If a check fails, fix the root cause and re-run. Do not bypass pre-push hooks.

Summarize: which checks passed, which failed, and what needs fixing. $ARGUMENTS
