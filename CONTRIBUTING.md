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

You'll need [Bun](https://bun.sh) ≥ 1.3 installed. Then:

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
bun dev desktop        # optional: start the Electron desktop shell too
```

After editing code:

```bash
bun dev build app       # rebuild the web app
bun dev build desktop   # rebuild Electron main/preload
```

See the [Development section in README](README.md#development) for the full workflow — production builds, test commands, SDK generation, and more.

## Pull Request Process

1. **Keep changes focused.** One logical change per PR. If you find an unrelated issue while working, open a separate PR for it.
2. **Run the quality preflight.** Before opening your PR, run at minimum:

   ```bash
   bun run quality:quick
   ```

   This checks formatting, linting, type-checking, monorepo dependency consistency, and package publishing validation. For a full check including all tests:

   ```bash
   bun run quality
   ```

   CI runs the full matrix — see [docs/open-source-quality.md](docs/open-source-quality.md) for the complete model.

3. **Regenerate the SDK if you touched routes.** If your change modifies server routes or route schemas, run `./script/generate.ts` and include the output in your PR.

4. **Open your PR against `dev`.** Describe what you changed and why. If it addresses an open issue, reference it.

### Pre-push vs CI layering

The pre-push hook (`.husky/pre-push`) runs a fast subset: bun version check, formatting, lint, typecheck, and monorepo dependency validation. It does not run tests, secret scans, or workflow validation — those run in CI as separate parallel jobs. All CI jobs must pass for a PR to merge.

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

Knowing where things live saves time:

| Package            | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `packages/synergy` | Core runtime, server, CLI, agents, tools, sessions |
| `packages/app`     | Web application                                    |
| `packages/plugin`  | Plugin SDK (`@ericsanchezok/synergy-plugin`)       |
| `packages/sdk/js`  | TypeScript SDK (`@ericsanchezok/synergy-sdk`)      |
| `packages/ui`      | Shared UI components                               |
| `packages/util`    | Shared utilities                                   |
| `packages/script`  | Build and release tooling                          |

If your change touches one package, scan adjacent packages before assuming an abstraction boundary.

## Questions?

If something isn't covered here, open a [Discussion](https://github.com/SII-Holos/synergy/discussions) or ask in an issue. There are no bad questions — only missing documentation that your question will help us write.
