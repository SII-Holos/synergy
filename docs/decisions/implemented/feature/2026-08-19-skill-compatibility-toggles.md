# Decision Record: Skill compatibility toggles and load diagnostics UX

Status: implemented

## Problem

Synergy discovers Skills from several external agent tools' directories (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.openclaw/skills`, plus project variants). Users who only want Synergy-native skills had no way to disable a compat source without deleting files or setting a hidden environment variable (claude only). Separately, the Library → Skills page rendered every load diagnostic as "N skill(s) skipped during load" — including compatibility warnings attached to skills that loaded successfully and shadowed-candidate notices — which misled users into thinking skills were broken or lost, and produced "技能s" in zh-CN due to a `{plural}` placeholder hack.

## Decision

Add a first-class per-source compatibility toggle in a new `skills` config domain (`55-skills.jsonc`) with shape `skills.compatibility.{agents,claude,codex,openclaw}` (optional booleans, missing = enabled), surfaced in a new Settings → Library → Skills section with per-source candidate counts. Filtering happens inside the async `Skill.state` init: disabled sources are excluded from materialization and winner competition (no diagnostics are emitted for hidden skills). The existing claude env-flag stays a hard override (effective claude enablement = config AND NOT flag). Changes apply live: `inferConfigCascades` maps `skills → skill`, `skills` is in `CONFIG_LIVE_APPLIED`, and the domain's `reloadTargets: ["config"]` makes the file watcher reload the config first, after which the serial cascade rebuilds skill state — the single reload path (settings save and watcher) avoids a parallel `["config", "skill"]` race where `Skill.state` could initialize against a stale config cache mid-reload.

The settings patch writes only the diverging compatibility fields (`patch.skills.compatibility` carries just the toggles the user changed), so saving one toggle never re-writes merged project-level overrides into the global `55-skills.jsonc` and bakes them in.

The library banner is replaced with grouped truthful copy: `failed` (severity error), `shadowed` (`skill.candidate_shadowed`), `compat` (other warnings/info), deduplicated by path+code, with proper lingui pluralization in en and zh-CN.

Standard Agent Skills / Claude Code frontmatter fields (`argument-hint`, `model`, `effort`, `context`, `agent`, `hooks`) are declared in the strict manifest schema as ignored `unknown` fields, so ecosystem-authored skills load under strict sources (`synergy`, `agents`) without diagnostics. Nested `SKILL.md` entries under a skill's `references/` directory are resource material, not skill candidates, and are excluded from the filesystem scan so they cannot surface as load errors.

## Alternatives considered

- **Env-flag-only toggles** — rejected: not discoverable, not persistable per user, no UI, duplicates the claude-flag mechanism.
- **Putting the key in the `general` domain** — rejected: buries a real product area in a grab-bag file and loses a dedicated import/export/Config Files unit; a `skills` domain matches the one-domain-per-area pattern.
- **Making `allRoots`/`existingRoots` async or config-aware** — rejected: breaks the synchronous watcher/reload-path call sites; filtering in the async state init keeps the watcher root set unfiltered (benign over-detection: a reload in a disabled source just finds nothing).
- **Separate `/skill/sources` endpoint** — rejected: the list response already flows through the same cached state; extending `SkillSummary.List` with `sources` costs nothing.
- **Promoting runner-up candidates when the winner's source is disabled** — rejected: confusing UX; disabled sources are simply excluded from competition.
- **Restart-required semantics for toggles** — rejected: the existing reload cascade makes live-apply free; a dedicated reload test locks it in.
- **Restructuring the diagnostics API into per-item skip reasons** — rejected: client-side partition of existing diagnostics is sufficient and testable.

## Consequences

- Disabling a source hides its skills from `Skill.all()` (library, skill tool, session catalog) after an automatic reload; files on disk are untouched; counts remain truthful because they are recorded during the unfiltered scan.
- Count semantics are per-source candidate entry-file counts (pre-dedup, pre-shadowing), computed during the same scan pass; the panel copy says "N skills" to avoid implying post-dedup counts.
- Project-level `synergy.d` fragments can still override `skills.compatibility` per key through the normal config merge; the home-scope Settings UI does not show project values.
- The `55-skills.jsonc` filename slot (between 50-plugins and 60-agents) is stable and ordered; `assertRegistryComplete` keeps schema and domain in sync.
