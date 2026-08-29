# Decision Record: Instruction domain unification — template engine, source registry, and domain migration

Status: implemented

## Problem

The skill and command template renderers were 80% duplicated (`argumentPattern`/`quotePattern` identical, the `$N`-highest-consumes-remainder rule written twice), and the session loop forked on the command source kind (`session/invoke.ts` `command.source === "skill" ? SkillRenderer.render(...) : [await CommandRenderer.render(...)]`). Inversion point P7 of the layering program: L1 (`session`, `tool`) statically imported the `skill`/`command` product domains for rendering, hints, and the skill-tool catalog, and the product layer carried two raw source edges (`skill→plugin` for `Plugin.skillEntries()`, `command→mcp` for prompt listing, subscription, and resolution).

## Decision

Implement H7 as a two-commit slice (S7a engine + goldens, S7b domain migration):

- **`instruction/engine.ts` (L1, pure)**: one text-substitution engine covering the syntax superset — `$N` one-based positional with the highest position consuming the remainder, `$ARGUMENTS` raw trailing text (quotes preserved), `$ARGUMENTS[N]` zero-based indexed, shared tokenizer. An `appendArgsWhenNoPlaceholder` option models the skill's no-placeholder fallback (appended second part); the default models the command's discard. Shell syntax stays literal — policy never enters the engine.
- **`instruction/registry.ts` (L1)**: `InstructionRegistry` maps source kinds to `{ render, hints, list?, entries?, entry?, diagnostics? }`. Unknown kinds degrade to the trimmed template with a `log.warn` instead of failing the session loop. The optional catalog surface (`entries`/`entry`) lets the L1 skill tool list, load, and reference instructions without importing the owning domain.
- **`instruction/source-provider.ts` (L1)**: `SkillSourceProviders` and `CommandSourceProviders` invert the raw source edges — the skill domain reads plugin entries through a provider registry (registered by `plugin/skill-source.ts`, late-bound to `Plugin.skillEntries` so test doubles keep intercepting), and the command domain reads MCP prompts/subscriptions through a provider (`mcp/instruction-source.ts`, which owns the three MCP change-event subscriptions that used to live in `command.ts`).
- **Domain migration**: `skill/source-profile.ts` moved to `instruction/source-profile.ts` (it was always L1 material — pure path policy with zero product dependencies). `skill/references.ts` extracted so the registry catalog can resolve references without exposing `Skill.Info` to L1. `skill/register.ts` and `command/register.ts` mount the sources (`skill`: engine append semantics + hints + catalog; `command` and `mcp`: engine + shell/trim policy stages) and are listed in `product-registration.ts`.
- **Call-site collapse**: `session/invoke.ts` renders every command through `InstructionRegistry.render(command.source ?? "command", ...)`; `command.ts` derives skill-command hints from `InstructionRegistry.get("skill")?.hints()`; `tool/skill.ts` reads its entire catalog through the registry (description listing, entry lookup, diagnostics, references, compatibility) — no `Skill` import remains in L1's tool domain.
- **Behavior compat locked by goldens before rewiring**: `test/instruction/engine.test.ts` (11 cases) and the extended `test/command/renderer.test.ts` matrix (placeholder substitution, `$ARGUMENTS` raw contract, append-vs-discard, command trim, `!`command``shell expansion) plus`test/instruction/registry.test.ts` asserting the three sources mount from the product manifest and byte-equal semantics per kind.

## Alternatives considered

- **Shell expansion inside the engine** — rejected: shell execution is policy (enforcement/approval/identity); a pure L1 engine must stay free of execution semantics. The command source composes the engine with its own shell stage.
- **Collapsing skill and command into one domain module** — rejected: they remain separate product surfaces with different policy stages and catalogs; only the engine and registry are shared.
- **Keeping `tool/skill.ts` reading `Skill` directly with a type-only import** — rejected: type-only edges still appear in the module graph, and the tool genuinely needs runtime catalog access; the registry catalog is the honest seam.
- **Registering MCP subscriptions inside the command domain as today** — rejected: that is the `command→mcp` edge the slice exists to remove; the provider owns its own subscriptions.

## Consequences

- The session loop no longer forks on instruction source kinds; new instruction domains register a source and are renderable with zero L1 edits.
- `CommandRenderer`'s Bun `$` shell execution remains a known security observation (bypasses enforcement boundaries); recorded here per the program non-goal, to be fixed in dedicated follow-up work — behavior is byte-equal in this slice.
- Tests that exercise registry-backed paths mount the domains explicitly (`registerSkillDomain()`/`registerCommandDomain()` or the product manifest import), mirroring the established continuation-kernel/workflow-registry test pattern.
- Snapshot: L1→product edges 45→43 (`session→skill`, `tool→skill` removed), product pairs 41→39 (`skill→plugin`, `command→mcp` removed), R3 violations 0, depcruise warnings 161→… (advisory until S10). `scope→command` and the `session→command` dynamic-import edge remain for S8/S9 (tool-partition and scattered-edge slices).
