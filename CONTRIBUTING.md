# Contributing to Synergy

Thanks for wanting to contribute. Synergy is built by a small team, and outside contributions genuinely help — whether that's a bug report, a documentation fix, or a new feature.

This guide covers what you need to get started.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/SII-Holos/synergy/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce (the more specific, the faster the fix)
- Your environment: OS, Bun version, Synergy version

If you're not sure whether something is a bug or intended behavior, open the issue anyway. We'd rather triage a question than miss a real problem.

## Suggesting Features

For feature ideas or design discussions, open a [GitHub Issue](https://github.com/SII-Holos/synergy/issues) or start a [Discussion](https://github.com/SII-Holos/synergy/discussions). A good suggestion explains the problem you're trying to solve, not just the solution you have in mind — that context helps us find the right approach.

## Development Setup

Use the Bun version pinned by the root `packageManager` field. Then:

```bash
git clone https://github.com/SII-Holos/synergy.git
cd synergy
bun install
```

First-time setup:

```bash
bun dev prepare        # install deps, generate SDK, build frontend
```

Start the dev server:

```bash
bun dev web            # start the server + Vite web UI
bun dev desktop        # alternative: server + Vite + Electron
```

After editing code:

```bash
bun dev build app       # rebuild the web app
bun dev build desktop   # rebuild Electron main/preload
```

See the [development reference](docs/reference/development.md) for source modes, isolated-runtime testing, builds, tests, SDK generation, and quality checks.

## Pull Request Process

1. **Keep changes focused.** One logical change per PR. If you find an unrelated issue while working, open a separate PR for it.
2. **Run the quality preflight.** Before opening your PR, run at minimum:

   ```bash
   bun run quality:quick
   ```

   This checks formatting, linting, type-checking, monorepo dependency consistency, localization, package-guide and test-layout contracts, and package publishing validation. For a full check including all tests:

   ```bash
   bun run quality
   ```

   Harness CI isolation can be reproduced from `packages/harness` with `bun run test:ci`, which runs its complete suite as sequential fresh-process shards. Other runtime and business packages run their own tests; the root quality command includes the workspace graph.

   CI runs the full matrix — see [docs/operations/open-source-quality.md](docs/operations/open-source-quality.md) for the complete model.

   Frontend copy, accessibility text, and locale-sensitive formatting must also keep the localization catalogs and source contract current:

   ```bash
   bun run --cwd apps/web i18n:extract
   bun run localization:check
   ```

   Browser capability or App bootstrap changes must also verify the source boundary and a genuine non-loopback HTTP origin:

   ```bash
   bun test --cwd apps/web test/testing/browser-crypto-contract.test.ts
   bun run --cwd apps/web build
   bun apps/web/script/private-http-smoke.ts
   ```

3. **Regenerate the SDK if you touched routes.** If your change modifies server routes or route schemas, run `./script/generate.ts` and include the output in your PR.

4. **Open your PR against `dev`.** Describe what you changed and why. If it addresses an open issue, reference it.

### Pre-push vs CI layering

The pre-push hook (`.husky/pre-push`) runs a fast subset: Bun version check, formatting, lint, typecheck, monorepo dependency validation, documentation, and decision validation. It does not run tests, secret scans, or workflow validation — those run in CI as separate parallel jobs. All CI jobs must pass for a PR to merge.

### Commit guidelines

Keep commits focused on a single logical change. Write commit messages that explain _what_ changed and _why_ — not just "fix bug" or "update code." If a commit relates to an issue, reference it in the message.

There is no enforced commit message format. Clear and descriptive is all we ask.

Do not commit secrets, local state files, placeholder credentials, or redundant wrapper scripts. If your change adds a feature or behavior that can be verified, include a test.

## Code Style

Match the patterns you find in the surrounding code. A few specifics worth knowing:

- **Namespace-based organization** is the established pattern for modules. Extend that pattern for related code.
- **Zod** handles runtime validation. Add `.meta({ ref: "TypeName" })` for API-exposed schemas.
- **`const` over `let`**, early returns over deep nesting.
- **No inline comments** unless explicitly needed. The code should be clear without them.
- **No copyright or license headers** in files.
- **Bun APIs** for file operations (`Bun.file()`, `Bun.write()`), not Node.js equivalents.

When in doubt, look at a nearby file doing something similar and follow its lead.

## Monorepo Structure

Choose the owner by responsibility. Harness owns execution and lifecycle mechanisms; Runtime Local supplies model and local-system implementations; CLI and Server expose execution through command-line and HTTP/WS interfaces; Product Runtime explicitly assembles the complete product. Business packages own their services together with tools, routes, configuration, migrations and command contributions. Web and Desktop interfaces live under `apps/`.

Follow the [architecture ownership map](docs/architecture/README.md#ownership-map) and [package map](docs/reference/packages.md) for package responsibilities, public imports and standalone builds. A package is a dependency and distribution unit; creating a package does not create another process. Import only declared exports and keep generic execution independent of optional business capabilities. Inspect adjacent owners before changing a shared operation.

The full installation still publishes the same `synergy` executable and complete default product. Source ownership changes must preserve command names and aliases, configuration and storage paths, migrations, API operation IDs, events, installed assets and update behavior. Validate both source startup and actual packaged installation when a change crosses those surfaces.

## Questions?

If something isn't covered here, open a [Discussion](https://github.com/SII-Holos/synergy/discussions) or ask in an issue. There are no bad questions — only missing documentation that your question will help us write.
