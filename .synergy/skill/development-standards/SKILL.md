---
name: development-standards
description: Route a Synergy source change to the current repository development workflow and keep durable engineering rules synchronized. Use before cross-cutting implementation work, when no existing Skill clearly owns a change, when code review reveals a reusable convention, or when adding/changing repository development policy under AGENTS.md, docs, or .synergy/skill.
---

# Apply Development Standards

## Establish Ownership

1. Read the nearest `AGENTS.md` and [Development reference](../../../docs/reference/development.md).
2. Trace the current implementation with `architecture` when ownership crosses packages or domains.
3. Check whether the change needs a decision record: every non-trivial change MUST add or update an implemented record in `docs/decisions/` in the same PR (mechanical/local edits exempt). Follow the path-encoded lifecycle/class scheme and format contract in [Decision records](../../../docs/decisions/README.md); validate with `bun run decision:check`.
4. Load every focused workflow that applies:
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
   - broad simplification audits or decision-record coalescing: `find-simplifications`
5. Use canonical product, architecture, reference, plugin, and operations documents for system truth. Keep Skills procedural; do not copy whole architecture descriptions into them.

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

## Preserve Harness-Core Layering

The `packages/synergy/src/` layer boundary is machine-enforced. Before adding any import, classify both endpoints with the layer table in [Ownership Map](../../../docs/architecture/README.md#ownership-map):

1. L1 harness-core directories (`session/`, `tool/`, `agent/`, `config/`, `provider/`, `enforcement/`, `permission/`, `scope/`, `bus/`, `storage/`, `file/`, `workspace-file/`, `observability/`, `instruction/`, `migration/`, `sandbox/`, `control-profile/`) must never import product domains (`plugin/`, `cortex/`, `channel/`, `browser/`, `mcp/`, `blueprint/`, `lattice/`, `boss/`, `light-loop/`, `library/`, `note/`, `agenda/`, `holos/`, `skill/`, `command/`, `project/`, `question/`, `lsp/`, `email/`, `synergy-link/`, `remote/`, `acp/`, `external-agent/`, `superplan/`, `performance/`) or assembly (`server/`, `runtime/`, `cli/`, `daemon/`, `main/`). R1 is error-level.
2. When L1 needs product behavior, invert it through the existing L1 port registries — `SessionPluginHooks`, `SessionToolContext`, `SessionCortexRuntime`, `SessionBlueprintState`, `InstructionRegistry`, `ToolMcpSource`, `ScopeStartup`, `RuntimeReloadExecutor`, `SkillSourceProviders`, `CommandSourceProviders`, `SessionEnvContributor` — with the product-side adapter registered in `src/product-registration.ts`. Do not invent a parallel registry when one of these fits.
3. Product domains stay acyclic (R2, error). Break a new product↔product ring with the established patterns: extract a shared leaf module, or use a domain-internal setter injection (precedent: `setTerminalHookDeliverer`).
4. New product-domain tools, migrations, and startup steps belong in the owning domain (`<domain>/tools.ts`, `<domain>/migration.ts`, `<domain>/startup.ts`), wired through the manifest — never appended to `tool/registry.ts` builtin arrays or `scope/runtime.ts`.
5. Verify with `bun run deps:check` (repo root) before finishing; refresh the recorded baseline with `bun run deps:snapshot` only when the change is intentional, and explain the edge movement in the decision record.

Do not add a rule only to a PR comment, prompt, or one package guide if future agents need it to implement the same change correctly.

## Preserve External Provenance

When implementation materially adopts an algorithm or constraint from a paper or standard, upstream code, an issue/PR/discussion workaround, or a benchmark, experiment, or research result:

1. Add `Provenance:` with a stable locator beside the nearest authoritative implementation. Prefer a DOI, versioned arXiv record, RFC section, commit-pinned source link, issue/PR URL, or repository-relative research document.
2. Add `Local adaptation:` stating what Synergy adopts or changes. For multi-file or generated output, mark the single owning source, generator, template, or manifest rather than every derivative.
3. Preserve applicable license obligations when code, data, themes, or assets are copied or adapted.
4. Carry cross-cutting sources into the decision record and pull request so reviewers can evaluate the source-to-implementation relationship.

Routine language usage, direct official API calls, and general patterns without a specific material source do not require citations. A bare URL or a source recorded only in Git history is not durable provenance. A marker is a `Provenance:` locator line paired with a `Local adaptation:` line — unrelated uses of the word "provenance" in identifiers, fields, or metadata are not markers. Review enforces this semantic obligation; do not add a network or keyword CI gate that claims to detect missing sources.

## Handoff

Report the owning workflows loaded, invariant changed, focused checks run, and any Skill or canonical document updated because a new development convention emerged.
