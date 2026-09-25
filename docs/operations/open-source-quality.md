# Open Source Quality

Synergy runs a multi-layer quality system that covers formatting, linting, type-checking, monorepo hygiene, CI workflow validation, secret scanning, package publishing validation, and tests. This runbook describes local quality commands. CI task ownership, scheduling and admission are defined in [CI verification](ci.md).

## Quality Layers

| Layer                      | Local command                                                               | CI task           | Tool                             | Pre-push |
| -------------------------- | --------------------------------------------------------------------------- | ----------------- | -------------------------------- | -------- |
| Bun version check          | (pre-push only)                                                             | —                 | `check-bun-version`              | ✅       |
| Formatting                 | `bun run format:check`                                                      | `policy`          | Prettier                         | ✅       |
| Lint                       | `bun run lint`                                                              | `static`          | oxlint                           | ✅       |
| Browser crypto contract    | `bun test --cwd apps/web test/testing/browser-crypto-contract.test.ts`      | `suite-apps-web`  | Bun source contract              | —        |
| Localization               | `bun run localization:check`                                                | `static`          | Lingui + source contract         | —        |
| Type checking              | `bun run typecheck`                                                         | `typecheck`       | tsc via turbo                    | ✅       |
| Monorepo deps              | `bun run monorepo:check`                                                    | `static`          | sherif                           | ✅       |
| Dead code                  | `bun run deadcode`                                                          | `static`          | knip                             | —        |
| CI workflow lint           | `bun run workflow:check`                                                    | `policy`          | actionlint + zizmor              | —        |
| Secret scanning            | `bun run secrets:check`                                                     | `policy`          | gitleaks                         | —        |
| Package validation         | `bun run package:check`                                                     | `packages`        | publint + attw                   | —        |
| Tests                      | `bun turbo test` / `bun run --cwd packages/harness test:ci`                 | `suite-*`         | One instrumented suite execution | —        |
| Private HTTP browser smoke | `bun run --cwd apps/web build && bun apps/web/script/private-http-smoke.ts` | `web-integration` | Playwright Chromium              | —        |
| Desktop checks             | `bun run desktop:test`                                                      | `desktop`         | bun test + build                 | —        |
| Server health smoke        | —                                                                           | `smoke`           | Synergy health check             | —        |

### Pre-push hook (`.husky/pre-push`)

The pre-push hook runs these checks in sequence. If any fails, the push is blocked:

1. `bun script/check-bun-version.ts` — verify the local bun version matches `package.json`
2. `bun run format:check` — verify all files are formatted
3. `bun run lint` — run oxlint with deny-warnings
4. `bun run typecheck` — type-check all packages via turbo
5. `bun run monorepo:check` — validate monorepo dependency consistency
6. `bun run doc:check` — validate current documentation and generated references
7. `bun run decision:check` — validate decision records

The pre-push hook is intentionally fast — it covers the most common issues but does not run tests, secret scans, or workflow validation. Those run in CI.

### Quick local check

```bash
bun run quality:quick    # format + lint + Skill/package-guide/test-layout checks + localization + typecheck + monorepo/package checks
```

### Full local check (before opening a PR)

```bash
bun run quality          # quality:quick + release contracts + workspace tests
```

This runs the full suite locally. CI runs the same checks in parallel jobs.

## CI Pipeline

CI runs on every push to `dev` / `main`, pull requests targeting those branches, and the daily cold-cache validation of latest `dev`. [CI verification](ci.md) owns the task catalog, dependency selection, runner limits, reports and rollout admission.

Package suites execute once with coverage and JUnit. Harness keeps four stable partitions and its isolated files. `web-integration` owns the production browser smoke and plugin UI contracts; `root-tests` owns script/release contracts; `installed-runtime` owns compiled core/full and installed package verification. PostgreSQL 16/17/18, Windows, sandbox, Desktop, long rollout and benchmark scenarios remain explicit tasks. Type and package checks each execute once in the Linux graph.

`All checks passed` verifies every selected task, job outcome, exact commit and workflow attempt, report hash, complete test inventory and coverage floor. PR selection starts in shadow mode; dev/main pushes stay full. Diagnostics cannot satisfy the required check. Oryn's independent review queue retains its own governance.

## Tool Responsibilities

| Tool                    | Responsibility                                                                                        | When to run                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Prettier                | Repository-wide formatting                                                                            | Every change through `bun run format:check`; write fixes with `bun run format` or `./script/format.ts`                   |
| oxlint                  | Fast JavaScript/TypeScript linting without style-heavy churn                                          | Every change through `bun run lint`; auto-fix safe issues with `bun run lint:fix`                                        |
| sherif                  | Workspace package and dependency consistency                                                          | Every change through `bun run monorepo:check`, especially package manifest edits                                         |
| knip                    | Dead code, unused dependencies, unused scripts, unresolved entries, and catalog hygiene               | CI and explicit local checks through `bun run deadcode`; configure precise entries/ignores for dynamic or generated code |
| publint                 | npm package manifest, exports, and publish-shape validation                                           | Publishable package, release, SDK, plugin, util, or Synergy Link protocol changes through `bun run package:check`        |
| attw                    | TypeScript package resolution validation for published tarballs                                       | Same path as publint through `bun run package:check`                                                                     |
| actionlint              | GitHub Actions syntax and expression validation                                                       | Workflow changes through `bun run workflow:check` and CI `policy`                                                        |
| zizmor                  | GitHub Actions security analysis                                                                      | Workflow changes through `bun run workflow:check` and CI `policy`                                                        |
| gitleaks                | Secret and credential scanning                                                                        | Auth/provider/channel/config example changes through `bun run secrets:check`; all PRs through CI `policy`                |
| Localization gate       | Catalog extraction drift, complete zh-CN coverage, strict ICU compilation, and App/UI source policy   | Product copy, accessibility text, locale formatting, or shared UI changes through `bun run localization:check`           |
| Browser crypto contract | Direct browser randomness under App/UI source must use the shared ordinary or strict utility boundary | Browser capability or identifier changes; affected Web suites and all full runs through `suite-apps-web`                 |

## Package Publishing Validation

The `package:check` script validates every publishable npm package in the monorepo:

The check uses the same module packer as releases for every registry entry in `script/release/shared/packages.ts`, including Harness, Local Runtime and all optional components. Every archive runs **publint**. Node-compatible SDK, Util, Plugin, Plugin Kit, protocol and detector packages also run **attw** with the ESM profile (Link Protocol retains its existing exclusion). Bun runtime packages carry source types and compiled Bun modules; their executable and worker contracts are tested through installation into a separate directory, rather than treating Node resolution as evidence of Bun execution.

Static package checks omit native binary construction; platform release jobs build and validate those binaries and the complete installed graph. Tracked manifests are never rewritten by package checks. The product wrapper remains a separate compatibility distribution and also runs publint.

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

The `secrets:check` script scans a temporary snapshot of tracked and non-ignored untracked source files, omitting deleted paths and external symlinks. Generated build outputs and private ignored runtime homes are excluded from that snapshot. CI scans the checked-out source tree. Both use gitleaks with the default rules and explicit fixture/fake-token exceptions.

Run locally (requires gitleaks installed):

```bash
brew install gitleaks       # macOS
bun run secrets:check
```

## Failure Guidance

| Failure        | Likely cause                                                                 | Fix                                                                                                                |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Formatting     | Unformatted files                                                            | `./script/format.ts` and re-stage                                                                                  |
| Lint           | Code style violations                                                        | `bun run lint:fix` or fix manually                                                                                 |
| Localization   | Catalog drift, missing translation, invalid ICU, or unclassified source copy | Re-extract and translate catalogs, or fix/classify the source violation                                            |
| Typecheck      | Type errors                                                                  | Fix type errors in affected files                                                                                  |
| Monorepo check | Version mismatch across workspaces                                           | Sync catalog versions in root `package.json`                                                                       |
| Dead code      | Unused dependencies or exports                                               | Remove or export as needed                                                                                         |
| Workflow check | actionlint or zizmor violation                                               | Fix workflow file syntax or security issue                                                                         |
| Secret scan    | Credential leaked in code                                                    | Rotate credential, rewrite history, update allowlist                                                               |
| Package check  | publint or attw failure                                                      | Fix package.json exports or module resolution                                                                      |
| Test failure   | Runtime regression, leaked process state, or brittle isolation               | Run the focused test, then `bun run test:ci` from `packages/harness`; inspect the uploaded per-shard JUnit reports |

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
cd packages/harness
bun test <relevant test files>
cd ../..
bun run quality:quick
```

For the complete core-runtime CI boundary, run `bun run test:ci` from `packages/harness`. It executes four shards sequentially in fresh Bun processes; CI uploads one JUnit report per attempted shard.

### I changed frontend or UI package behavior

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd packages/ui test
bun run --cwd apps/web build
bun turbo test
bun run quality:quick
```

Browser capability or bootstrap changes also run the static boundary and genuine non-loopback HTTP smoke:

```bash
bun test --cwd apps/web test/testing/browser-crypto-contract.test.ts
bun run --cwd apps/web build
bun apps/web/script/private-http-smoke.ts
```

For product copy, accessibility text, or locale-sensitive formatting, update the catalogs before those package and root gates:

```bash
bun run --cwd apps/web i18n:extract
bun run localization:check
```

The App and shared UI packages both expose standard `test` scripts, so `bun turbo test` includes their centralized `test/` suites. The App runner isolates its production CSS build contract from the unit-test process; the UI runner isolates the session-turn timeline suite because its process-wide module mocks must not leak into other shared UI tests.

For theme or color-token work, regenerate and verify the checked-in artifacts before the package suites:

```bash
bun run --cwd packages/ui generate:theme
bun test --cwd packages/ui test/theme.test.ts test/theme-generation.test.ts
bun test --cwd apps/web test/testing/color-token-contract.test.ts
```

## Documentation Sync Rules

When a change adds or modifies quality commands, scripts, CI tasks, or pre-push checks, update:

1. `docs/operations/open-source-quality.md` — quality model and command/CI tables
2. `README.md` — the `### Quality commands` section
3. `CONTRIBUTING.md` — PR preflight quality flow
4. `AGENTS.md` — "Testing/Verification" and "Documentation Sync Rules" sections
5. `packages/presets/AGENTS.md` — scoped quality commands for core runtime
6. `apps/web/AGENTS.md` — scoped frontend/app verification
7. `.github/PULL_REQUEST_TEMPLATE.md` — checklist entries
8. `.synergy/command/check.md` — agent check command
9. `.husky/pre-push` — hook content (verify the hook script itself)
10. `llms.txt` — "Source Verification" section
