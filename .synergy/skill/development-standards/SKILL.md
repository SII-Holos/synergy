---
name: development-standards
description: Route a Synergy source change to the current repository development workflow and keep durable engineering rules synchronized. Use before cross-cutting implementation work, when no existing Skill clearly owns a change, when code review reveals a reusable convention, or when adding/changing repository development policy under AGENTS.md, docs, or .synergy/skill.
---

# Apply Development Standards

## Establish Ownership

1. Read the nearest `AGENTS.md` and [Development reference](../../../docs/reference/development.md).
2. Trace the current implementation with `architecture` when ownership crosses packages or domains.
3. Load every focused workflow that applies:
   - Web/shared product UI: `develop-frontend`
   - LLM or internal-agent invocation: `integrate-llm`
   - HTTP route, OpenAPI, SDK, or Web API client: `change-server-api`
   - durable state, schema, index, or migration: `change-persistence`
   - capabilities, permissions, control profiles, enforcement, or sandboxing: `change-execution-boundaries`
   - Channel targets, providers, managed Projects, or Native Clarus: `change-channel-runtime`
   - Browser ownership/control, Desktop native presentation, or WebRTC: `change-browser-runtime`
   - plugin manifest, installation, runtime, bridge, marketplace, or UI host: `change-plugin-runtime`
   - built-in agent, CLI command, or first-party tool: `add-agent`, `add-cli-command`, or `add-tool`
   - tests or manual runtime validation: `testing-guide` and `develop-synergy`
   - Git/worktree/PR operations: `git-guide`
4. Use canonical product, architecture, reference, plugin, and operations documents for system truth. Keep Skills procedural; do not copy whole architecture descriptions into them.

## Implement from Current Evidence

1. Inspect schemas, tests, generated contracts, and at least one neighboring implementation before choosing a pattern.
2. State the behavioral invariant and write the failing test first for new behavior or bug fixes.
3. Change the smallest coherent set of owners. Include migrations, events, SDK generation, UI registration, or docs only when the contract crosses them.
4. Run the narrowest verification first, then expand according to the affected workflow.

## Capture New Rules

A durable development convention is part of the implementation deliverable, not review folklore.

1. Search `.synergy/skill/` before recording a new rule.
2. Update the focused owning Skill in the same change when a reusable constraint, required registration, approved pattern, or verification step emerges.
3. Create a new verb-led development Skill when no existing workflow would reliably trigger for that class of change. Keep it focused and link it from this router, root `AGENTS.md`, and `llms.txt`.
4. Update canonical docs when the rule describes product or architecture truth; update `packages/app/PRODUCT.md` when it describes durable interaction or visual behavior.
5. Keep root/package `AGENTS.md` concise: retain safety, global invariants, and Skill routing there; put executable steps and examples in Skills.
6. Validate every changed or added Skill and its links with `bun run skill:check` from the repository root.
7. Keep one nearest `AGENTS.md` for every root workspace package and validate coverage with `bun run package-guide:check`.

Do not add a rule only to a PR comment, prompt, or one package guide if future agents need it to implement the same change correctly.

## Handoff

Report the owning workflows loaded, invariant changed, focused checks run, and any Skill or canonical document updated because a new development convention emerged.
