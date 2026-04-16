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

Start the dev server, then connect a client from a second terminal:

```bash
bun run --cwd packages/app build   # build the frontend (required before first run)
bun dev                             # start the server
bun dev web --dev                   # open the web UI with hot-reload (separate terminal)
bun dev send "hello"                # or send a one-off prompt
```

See the [Development section in README](README.md#development) for the full workflow — production builds, test commands, SDK generation, and more.

## Pull Request Process

1. **Fork and branch.** Create your branch from `dev` — that's where active development happens. `main` is for releases only.

2. **Keep changes focused.** One logical change per PR. If you find an unrelated issue while working, open a separate PR for it.

3. **Test your changes.** Run the test suite from the synergy package directory:

   ```bash
   cd packages/synergy
   bun test
   ```

   Also run type checking and formatting before submitting:

   ```bash
   bun run typecheck
   ./script/format.ts
   ```

4. **Regenerate the SDK if you touched routes.** If your change modifies server routes or route schemas, run `./script/generate.ts` and include the output in your PR.

5. **Open your PR against `dev`.** Describe what you changed and why. If it addresses an open issue, reference it.

## Code Style

Match the patterns you find in the surrounding code. A few specifics worth knowing:

- **Namespace-based organization** is the established pattern for modules. Extend it rather than introducing a parallel style.
- **Zod** handles runtime validation. Add `.meta({ ref: "TypeName" })` for API-exposed schemas.
- **`const` over `let`**, early returns over deep nesting.
- **No inline comments** unless explicitly needed. The code should be clear without them.
- **No copyright or license headers** in files.
- **Bun APIs** for file operations (`Bun.file()`, `Bun.write()`), not Node.js equivalents.

When in doubt, look at a nearby file doing something similar and follow its lead.

## Commit Guidelines

- Keep commits focused on a single logical change.
- Write commit messages that explain _what_ changed and _why_ — not just "fix bug" or "update code."
- If a commit relates to an issue, reference it in the message.

There's no enforced commit message format. Clear and descriptive is all we ask.

## Monorepo Structure

Knowing where things live saves time:

| Package              | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `packages/synergy`   | Core runtime, server, CLI, agents, tools, sessions |
| `packages/app`       | Web application                                    |
| `packages/config-ui` | Configuration UI                                   |
| `packages/plugin`    | Plugin SDK (`@ericsanchezok/synergy-plugin`)       |
| `packages/sdk/js`    | TypeScript SDK (`@ericsanchezok/synergy-sdk`)      |
| `packages/ui`        | Shared UI components                               |
| `packages/util`      | Shared utilities                                   |
| `packages/script`    | Build and release tooling                          |

If your change touches one package, scan adjacent packages before assuming an abstraction boundary.

## Questions?

If something isn't covered here, open a [Discussion](https://github.com/SII-Holos/synergy/discussions) or ask in an issue. There are no bad questions — only missing documentation that your question will help us write.
