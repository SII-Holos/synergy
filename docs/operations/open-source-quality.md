# Open Source Quality

Synergy runs a multi-layer quality system that covers formatting, linting, type-checking, monorepo hygiene, CI workflow validation, secret scanning, package publishing validation, and tests. This runbook describes each layer, when to use which command, and how CI and local checks interact.

## Quality Layers

| Layer              | Local command                | CI job                | Tool                     | Pre-push |
| ------------------ | ---------------------------- | --------------------- | ------------------------ | -------- |
| Bun version check  | (pre-push only)              | —                     | `check-bun-version`      | ✅       |
| Formatting         | `bun run format:check`       | `quality`             | Prettier                 | ✅       |
| Lint               | `bun run lint`               | `quality`             | oxlint                   | ✅       |
| Localization       | `bun run localization:check` | `quality`             | Lingui + source contract | —        |
| Type checking      | `bun run typecheck`          | `typecheck`           | tsc via turbo            | ✅       |
| Monorepo deps      | `bun run monorepo:check`     | `quality`             | sherif                   | ✅       |
| Dead code          | `bun run deadcode`           | `quality`             | knip                     | —        |
| CI workflow lint   | `bun run workflow:check`     | `workflow-validation` | actionlint + zizmor      | —        |
| Secret scanning    | `bun run secrets:check`      | `secret-scan`         | gitleaks                 | —        |
| Package validation | `bun run package:check`      | `package-validation`  | publint + attw           | —        |
| Tests              | `bun turbo test`             | `test`                | bun test                 | —        |
| Desktop checks     | `bun run desktop:test`       | `desktop`             | bun test + build         | —        |
| Smoke test         | —                            | `smoke`               | Synergy health check     | —        |

### Pre-push hook (`.husky/pre-push`)

The pre-push hook runs these checks in sequence. If any fails, the push is blocked:

1. `bun script/check-bun-version.ts` — verify the local bun version matches `package.json`
2. `bun run format:check` — verify all files are formatted
3. `bun run lint` — run oxlint with deny-warnings
4. `bun run typecheck` — type-check all packages via turbo
5. `bun run monorepo:check` — validate monorepo dependency consistency

The pre-push hook is intentionally fast — it covers the most common issues but does not run tests, secret scans, or workflow validation. Those run in CI.

### Quick local check

```bash
bun run quality:quick    # format + lint + Skills/package guides + localization + typecheck + monorepo/package checks
```

### Full local check (before opening a PR)

```bash
bun run quality          # quality:quick + all tests (turbo test)
```

This runs the full suite locally. CI runs the same checks in parallel jobs.

## CI Pipeline

CI runs on push to `dev` / `main` and on pull requests targeting those branches. Jobs run in parallel:

| Job                   | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `quality`             | Formatting, lint, localization, monorepo deps, dead code              |
| `typecheck`           | TypeScript type checking                                              |
| `test`                | All package tests + Synergy coverage                                  |
| `package-validation`  | publint + attw for publishable packages                               |
| `workflow-validation` | actionlint + zizmor for CI workflow files                             |
| `secret-scan`         | gitleaks for secrets and credentials                                  |
| `desktop`             | Desktop typecheck, unit tests, build config validation, runtime smoke |
| `smoke`               | Server health check smoke test                                        |

All jobs must pass for a PR to merge. The `package-validation` and `workflow-validation` jobs are not in the pre-push hook — they require network access or special tooling that is available in CI but may not be installed locally.

## Tool Responsibilities

| Tool              | Responsibility                                                                                      | When to run                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Prettier          | Repository-wide formatting                                                                          | Every change through `bun run format:check`; write fixes with `bun run format` or `./script/format.ts`                   |
| oxlint            | Fast JavaScript/TypeScript linting without style-heavy churn                                        | Every change through `bun run lint`; auto-fix safe issues with `bun run lint:fix`                                        |
| sherif            | Workspace package and dependency consistency                                                        | Every change through `bun run monorepo:check`, especially package manifest edits                                         |
| knip              | Dead code, unused dependencies, unused scripts, unresolved entries, and catalog hygiene             | CI and explicit local checks through `bun run deadcode`; configure precise entries/ignores for dynamic or generated code |
| publint           | npm package manifest, exports, and publish-shape validation                                         | Publishable package, release, SDK, plugin, util, or Synergy Link protocol changes through `bun run package:check`        |
| attw              | TypeScript package resolution validation for published tarballs                                     | Same path as publint through `bun run package:check`                                                                     |
| actionlint        | GitHub Actions syntax and expression validation                                                     | Workflow changes through `bun run workflow:check` and CI `workflow-validation`                                           |
| zizmor            | GitHub Actions security analysis                                                                    | Workflow changes through `bun run workflow:check` and CI `workflow-validation`                                           |
| gitleaks          | Secret and credential scanning                                                                      | Auth/provider/channel/config example changes through `bun run secrets:check`; all PRs through CI `secret-scan`           |
| Localization gate | Catalog extraction drift, complete zh-CN coverage, strict ICU compilation, and App/UI source policy | Product copy, accessibility text, locale formatting, or shared UI changes through `bun run localization:check`           |

## Package Publishing Validation

The `package:check` script validates every publishable npm package in the monorepo:

| Package                                | Build | publint | attw (esm-only) |
| -------------------------------------- | ----- | ------- | --------------- |
| `@ericsanchezok/synergy-sdk`           | ✅    | ✅      | ✅              |
| `@ericsanchezok/synergy-util`          | ✅    | ✅      | ✅              |
| `@ericsanchezok/synergy-link-protocol` | ✅    | ✅      | —               |
| `@ericsanchezok/synergy-plugin`        | ✅    | ✅      | ✅              |
| `@ericsanchezok/synergy-plugin-kit`    | ✅    | ✅      | ✅              |
| `@ericsanchezok/synergy` (wrapper)     | —     | ✅      | —               |

- **publint** validates package.json best practices (exports, types, module resolution)
- **attw** (`--profile esm-only`) verifies the published package works with ESM consumers
- The validation builds each package from source, packs a tarball, runs both tools, then restores the original package.json

Run locally:

```bash
bun run package:check
```

## Workflow Validation

The `workflow:check` script uses an installed `actionlint` binary when available, otherwise downloads the pinned actionlint release, then runs zizmor for GitHub Actions security analysis.

Run locally:

```bash
bun run workflow:check      # install actionlint locally to avoid the actionlint download fallback
```

## Secret Scanning

The `secrets:check` script and CI `secret-scan` job run gitleaks against the repository with the default rule set plus a narrow allowlist for fixture paths and explicit fake-token markers.

Run locally (requires gitleaks installed):

```bash
brew install gitleaks       # macOS
bun run secrets:check
```

## Failure Guidance

| Failure        | Likely cause                                                                 | Fix                                                                     |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Formatting     | Unformatted files                                                            | `./script/format.ts` and re-stage                                       |
| Lint           | Code style violations                                                        | `bun run lint:fix` or fix manually                                      |
| Localization   | Catalog drift, missing translation, invalid ICU, or unclassified source copy | Re-extract and translate catalogs, or fix/classify the source violation |
| Typecheck      | Type errors                                                                  | Fix type errors in affected files                                       |
| Monorepo check | Version mismatch across workspaces                                           | Sync catalog versions in root `package.json`                            |
| Dead code      | Unused dependencies or exports                                               | Remove or export as needed                                              |
| Workflow check | actionlint or zizmor violation                                               | Fix workflow file syntax or security issue                              |
| Secret scan    | Credential leaked in code                                                    | Rotate credential, rewrite history, update allowlist                    |
| Package check  | publint or attw failure                                                      | Fix package.json exports or module resolution                           |
| Test failure   | Runtime/behavior regression                                                  | Run `bun test` locally, inspect failing tests                           |

## Common Contributor Scenarios

### I just cloned the repo and want to make sure everything works

```bash
bun dev prepare
bun run quality
```

### I made a small change and want a fast check before commit

```bash
bun run quality:quick
```

For a narrower edit loop before the full quick gate, run the relevant individual command such as `bun run format:check`, `bun run lint`, `bun run localization:check`, `bun run typecheck`, or a focused package test.

### I'm about to push

The pre-push hook runs automatically. If you want to verify first:

```bash
bun run quality:quick
```

### I need to regenerate the SDK

```bash
./script/generate.ts
```

### I want to check my package.json will publish correctly

```bash
bun run package:check
```

### I changed workflows or auth/config examples

```bash
bun run workflow:check      # workflow syntax + security analysis
bun run secrets:check       # requires local gitleaks; CI always runs secret-scan
```

### I changed publishable package exports, release scripts, or SDK/plugin packages

```bash
bun run package:check
```

### I changed core runtime behavior

```bash
cd packages/synergy
bun test <relevant test files>
cd ../..
bun run quality:quick
```

### I changed frontend or UI package behavior

```bash
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd packages/ui test
bun run --cwd packages/app build
bun turbo test
bun run quality:quick
```

For product copy, accessibility text, or locale-sensitive formatting, update the catalogs before those package and root gates:

```bash
bun run --cwd packages/app i18n:extract
bun run localization:check
```

The App and shared UI packages both expose standard `test` scripts, so `bun turbo test` includes their co-located suites. The App runner isolates its production CSS build contract from the unit-test process; the UI runner isolates the session-turn timeline suite because its process-wide module mocks must not leak into other shared UI tests.

For theme or color-token work, regenerate and verify the checked-in artifacts before the package suites:

```bash
bun run --cwd packages/ui generate:theme
bun test --cwd packages/ui test/theme.test.ts test/theme-generation.test.ts
bun test --cwd packages/app src/testing/color-token-contract.test.ts
```

## Documentation Sync Rules

When a change adds or modifies quality commands, scripts, CI jobs, or pre-push checks, update:

1. `docs/operations/open-source-quality.md` — quality model and command/CI tables
2. `README.md` — the `### Quality commands` section
3. `CONTRIBUTING.md` — PR preflight quality flow
4. `AGENTS.md` — "Testing/Verification" and "Documentation Sync Rules" sections
5. `packages/synergy/AGENTS.md` — scoped quality commands for core runtime
6. `packages/app/AGENTS.md` — scoped frontend/app verification
7. `.github/PULL_REQUEST_TEMPLATE.md` — checklist entries
8. `.synergy/command/check.md` — agent check command
9. `.husky/pre-push` — hook content (verify the hook script itself)
10. `llms.txt` — "Source Verification" section
