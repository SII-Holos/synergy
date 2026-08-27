# Decision Record: Built-in authoring skills (prompt architect, agent tooling) and skill-creator methodology

Status: implemented

## Problem

When external users ask Synergy to generate a new agent system prompt, a set of agent tools, an MCP server, an agent-friendly CLI, or a new Skill, the built-in guidance was thin or mis-routed:

1. **`synergy-skill-creator`** covered only the Synergy manifest contract and invocation extensions (66 lines). It lacked the authoring methodology that makes Skills actually good: concise-by-default, degrees of freedom, progressive disclosure, and description-as-trigger.
2. **No built-in prompt-architecture guidance existed.** `synergy-config`'s `agents.txt` reference documents where to configure an agent and which `60-agents.jsonc` fields exist — it does not teach how to write a high-quality system prompt.
3. **No built-in tool/MCP/CLI authoring guidance existed.** `synergy-config`'s `mcp.txt` covers connecting existing MCP servers, not designing agent-facing tools or building servers.

External skills that solve these problems well were identified: `agent-system-prompt-architect` (CR-730, layered prompt architecture with prompt/runtime separation and an evaluation checklist), `tool-design` (muratcankoylan, tool-as-contract with a description four-questions and consolidation), `mcp-builder` (Anthropics, four-phase MCP server workflow), `cli-creator` (OpenAI, agent-friendly CLI command contract), and `skill-creator` (OpenAI, progressive disclosure and degrees of freedom).

## Decision

- **Upgraded `synergy-skill-creator`** (built-in, memory-backed, single content file, no references) from 66 lines to 104 lines: kept every existing Synergy-specific contract section (manifest fields, `allowed-tools` no-authorization note, invocation extensions, slash placeholders, verification) and added Core Principles (context is a public good, degrees of freedom), Progressive Disclosure (three levels, 500-line body cap, one-level-deep references, TOC for >100-line reference files), Description as Trigger, and a Creation Process. The skill remains user-invocable and model-invocable, and still ships no references or scripts.
- **Added built-in `synergy-prompt-architect`** with three references: `prompt-engineering-principles.txt`, `evaluation-checklist.txt`, `capability-modules.txt` (retrieval/grounding, code execution, support, research). It owns layered prompt architecture (9 layers), role definition (professional identity + domain; rejects brand/codename/pipeline-step roles), prompt-vs-runtime separation (a translation table from backend/implementation language to agent-readable behavior), capability vs runtime tool spec ("never invent the missing half"), compactness, safety baseline, reasoning control modes, few-shot calibration, and a multi-turn revision protocol driven by the evaluation checklist. Synergy localization: configuration mechanics route to `synergy-config`; prompt language follows the user's language.
- **Added built-in `synergy-agent-tooling`** with three references: `tool-design.txt`, `mcp-builder.txt`, `cli-creator.txt`. It owns the tool contract (description four questions, consolidation, naming, parameter discipline, response formats, actionable error messages, audit checklist), the MCP server four-phase workflow (research/implement/test/evaluate with schema and annotations guidance), and the agent-CLI command contract (runtime choice, discovery/resolve/read/write separation, `--json`, auth priority, doctor, smoke test, companion-skill pattern). MCP connection config routes to `synergy-config`.
- **`synergy-config` stays the config-mechanics owner.** It received only routing pointers: two decision-tree rows and two Quick Reference paragraphs in `content.txt`, plus one pointer line in `agents.txt`, `mcp.txt`, and `skills-commands-plugins.txt` each. No authoring methodology was absorbed into it.
- **Harden the repository development skills** (`.synergy/skill/add-tool`, `add-cli-command`, `add-agent`) with one quality section each (Tool Description Quality, Command Contract, Prompt Quality), so "Synergy building Synergy" also inherits the principles.
- **Content is rewritten and localized, not vendored.** No external file is copied verbatim; no Codex/Claude-specific mechanisms (`.codex/` roots, `init_skill.py`, `ServerName:tool_name` syntax) entered the built-ins. No runtime Skill system code changed: the loading, normalization, precedence, permission, invocation, and packaging paths are untouched. New built-ins use the default invocation flags (`user-invocable: true`, model-invocable), so they auto-register as `/synergy-prompt-architect` and `/synergy-agent-tooling` slash commands.

## Alternatives considered

- **Absorb all authoring content into `synergy-config` references** — Rejected: it would double the config skill's reference size (~2,400 → ~5,500 lines), mix config-file mechanics with authoring methodology, lengthen its decision tree, and blur two distinct owners (config mechanics vs content creation). Routing pointers keep one owner per concern.
- **Ship the external skills as plugin or marketplace skills** — Rejected: not immediately available to new installs; the goal was built-in availability for every user.
- **Vendor the external repository files verbatim** — Rejected: third-party license obligations, upstream sync burden, and incompatible Codex/Claude-specific mechanisms. Principles are rewritten and localized instead.
- **Add `init_skill.py`/`quick_validate.py`-style scaffolding scripts to the creator skill** — Rejected: Synergy's verification path is `bun run skill:check` (repository skills) and reload + `skill(name:)` (runtime); extra scripts would duplicate that.
- **Extend the `BuiltinSkill` interface with invocation flags** — Rejected: the invocation-flag pipeline exists (programmatic manifest normalization) but built-ins have no need; default flags give the desired behavior.

## Consequences

- The Skill catalog grows from 4 to 6 built-ins. `BUILTIN_SKILL_COUNT`-derived tests and content phrase assertions were updated first (test-first), then content.
- Users get three world-class authoring entry points: `/synergy-prompt-architect`, `/synergy-agent-tooling`, and an upgraded `/synergy-skill-creator`; `synergy-config` routes creation requests to them instead of absorbing the methodology.
- Each new built-in carries three references (14-68 lines each), loaded on demand through `skill(name, reference:)`, keeping the always-loaded bodies compact (progressive disclosure applied to the built-ins themselves).
- `docs/reference/skills.md` documents the two new built-ins for discoverability.
- Behavior risk is limited to content: no runtime, manifest, permission, precedence, or packaging behavior changed. Editing built-in content still requires a backend restart in a running runtime.
- The decision record and content are English, matching the existing built-in skill language; generated prompts follow the user's language by design.
