# Skills

Skills are reusable instructions that Synergy discovers from trusted source roots, normalizes into one runtime catalog, and loads into model context only when selected. This page owns the exact Skill directory format, manifest fields, source precedence, invocation rendering, resource rules, import/export contract, reload behavior, and compatibility policy.

## Directory Format

A filesystem Skill is a directory with one Markdown entry file:

```text
<skill-root>/<skill-name>/SKILL.md
<skill-root>/<skill-name>/references/<optional-reference-files>
<skill-root>/<skill-name>/scripts/<optional-helper-files>
<skill-root>/<skill-name>/assets/<optional-assets>
```

`SKILL.md` contains YAML frontmatter followed by the Skill body:

```markdown
---
name: example-skill
description: Explain when and how to use the example workflow.
license: MIT
compatibility: Native Synergy Skill.
user-invocable: true
disable-model-invocation: false
---

Write the instructions the model should receive when the Skill is loaded.
```

For strict Skill sources, the entry file must be named exactly `SKILL.md`, and the containing directory name must match the manifest `name`. Lenient compatibility sources may also use `Skill.md`; they still normalize into the same runtime record. Existing `.agents/skills` entries created before this standardization remain loadable through the named `agents-pre-standardization-load` compatibility shim when they use `Skill.md`, unknown vendor fields, or another previously accepted non-standard shape.

The body after frontmatter is the Skill content. Files under `references/`, `scripts/`, `assets/`, or any other child directory stay as resources inside the Skill directory. References are not embedded into the canonical Skill record; they load on demand through the `skill` tool.

## Manifest Fields

Strict manifests accept this field set and reject unknown fields.

| Field                      | Required | Type    | Contract                                                                                                                                             |
| -------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | yes      | string  | Skill identifier. It must be 1-64 characters, lowercase, and contain only letters, digits, and single hyphens. It cannot start or end with a hyphen. |
| `description`              | yes      | string  | Catalog description shown to users and models. It must be 1-1024 characters.                                                                         |
| `license`                  | no       | string  | Declared license text for display and export metadata.                                                                                               |
| `compatibility`            | no       | string  | Declared author compatibility note, up to 500 characters.                                                                                            |
| `metadata`                 | no       | object  | Accepted author metadata. Synergy does not place it in the canonical runtime record.                                                                 |
| `allowed-tools`            | no       | string  | Accepted metadata describing author intent. It does not grant tool authorization.                                                                    |
| `user-invocable`           | no       | boolean | Defaults to `true`. When `false`, Synergy does not register the Skill as a slash command.                                                            |
| `disable-model-invocation` | no       | boolean | Defaults to `false`. When `true`, the Skill is omitted from the model-invocable `skill` tool catalog.                                                |

The runtime record stores normalized fields only: `name`, `description`, `declaredLicense`, `declaredCompatibility`, `invocation`, `origin`, `backing`, and `diagnostics`. It does not preserve raw frontmatter, arbitrary vendor fields, `allowed-tools`, or `metadata` as runtime authorization state.

`allowed-tools` is descriptive metadata only. Tool visibility and execution still come from the active agent, tool resolver, control profile, permission rules, Scope/workspace boundary, and sandbox. A Skill can ask the model to use a tool, but it cannot authorize that tool.

## Source Profiles and Roots

One `SkillSourceProfile` registry defines every filesystem source Synergy scans. Each profile declares its accepted entry names, validation mode, source rank, roots, scope, and writable destinations where applicable.

| Source       | Validation | Source rank | Accepted entries                   | Roots                                                                                                                                                                        |
| ------------ | ---------- | ----------: | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synergy      | strict     |         100 | `SKILL.md`                         | Project ancestors: `.synergy/skill`, `.synergy/skills`; global config: `skill`, `skills`; home: `.synergy/skill`, `.synergy/skills`; `SYNERGY_CONFIG_DIR`: `skill`, `skills` |
| Agent Skills | strict     |          80 | `SKILL.md`; legacy `Skill.md` shim | Project ancestors: `.agents/skills`; home: `.agents/skills`                                                                                                                  |
| OpenClaw     | lenient    |          80 | `SKILL.md`, `Skill.md`             | Workspace ancestors: `skills`; home: `.openclaw/skills`                                                                                                                      |
| Claude       | lenient    |          70 | `SKILL.md`, `Skill.md`             | Project ancestors: `.claude/skills`; home: `.claude/skills`                                                                                                                  |
| Codex        | lenient    |          60 | `SKILL.md`, `Skill.md`             | Project ancestors: `.codex/skills`; home: `.codex/skills`                                                                                                                    |

Root anchors resolve from the active `ScopeContext` directory. Ancestor roots include the active directory and walk upward toward the home directory; non-start ancestor roots are scanned only when they already exist. Home roots resolve under the process home anchor. Config roots resolve under the canonical config directory. `SYNERGY_CONFIG_DIR` adds Synergy-compatible config roots when set.

Claude-compatible Skill discovery is omitted when `SYNERGY_DISABLE_CLAUDE_CODE=1` or `SYNERGY_DISABLE_CLAUDE_CODE_SKILLS=1` is set for the process.

Synergy writes imported Skills only to Synergy roots:

| Import scope | Destination                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| `project`    | Existing `<active-project>/.synergy/skill` or `.synergy/skills`; otherwise `.synergy/skill` |
| `global`     | Existing `<config>/skill` or `<config>/skills`; otherwise `<config>/skill`                  |

Other source roots are compatibility inputs, not import destinations. Reusing an existing plural Synergy root prevents imports from creating a second parallel root in established projects or installations.

## Strict and Lenient Normalization

Strict and lenient sources share one parsing and normalization pipeline.

Strict sources are Synergy and Agent Skills. They require the strict manifest schema, reject unknown frontmatter keys, require `SKILL.md`, and require the directory name to match `name`. Invalid strict Synergy Skills do not enter the catalog; their diagnostics remain visible through Skill listing and reload results.

For backward compatibility, an Agent Skills candidate that fails strict validation is retried through the same lenient normalization pipeline only when the `agents-pre-standardization-load` shim declared by its SourceProfile applies. A loaded legacy entry receives both the field diagnostics and `skill.normalization_shim_applied`, remains non-standard for export, and does not weaken strict validation for new imports or Synergy roots.

Lenient sources are Claude, Codex, and OpenClaw. They require only a non-empty `name` and `description` to load. Supported Synergy fields normalize when their types are valid. Unknown vendor fields are ignored and reported as warnings. Invalid optional fields also produce warnings rather than inventing alternate runtime state.

Programmatic built-in and plugin Skills normalize through the same manifest rules before they enter the catalog. The built-in creator Skill is `synergy-skill-creator`, invoked as `/synergy-skill-creator` when user invocation is enabled by the command catalog.

## Deterministic Precedence

Synergy groups all valid candidates by normalized `name` and chooses one winner deterministically. The comparison order is:

1. scope rank;
2. source rank;
3. root rank;
4. entry path or programmatic identifier.

Scope ranks are `project` 40, `workspace` 35, `global` 20. Plugin and built-in programmatic candidates use lower scope ranks than filesystem project/workspace/global Skills, so a project Skill can override a plugin or built-in Skill with the same name.

Source rank breaks ties inside the same scope: Synergy outranks Agent Skills and OpenClaw, Agent Skills and OpenClaw outrank Claude, and Claude outranks Codex. Root rank follows the order in the source profile. The final path/identifier comparison makes ties stable.

Shadowed candidates do not disappear silently. The winning Skill receives `skill.candidate_shadowed` diagnostics that name the winner, the shadowed candidate, and their ranks.

## Invocation Flags and Slash Rendering

Two manifest flags control how a Skill can be invoked:

- `user-invocable: false` prevents slash-command registration for users.
- `disable-model-invocation: true` removes the Skill from the model-invocable `skill` tool catalog.

The flags are independent. A Skill may be user-only, model-only, both, or neither.

When a user invokes a Skill slash command, Synergy renders the Skill body with the Skill renderer, not the ordinary Command renderer. Skill placeholders are zero-based:

| Placeholder                      | Meaning                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `$0`, `$1`, `$2`                 | Positional quoted argument by zero-based index. Missing positions render as an empty string. |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]` | Positional quoted argument by zero-based index. Missing positions render as an empty string. |
| `$ARGUMENTS`                     | Raw trailing argument text exactly as entered.                                               |

Single-quoted and double-quoted arguments are treated as one value for indexed placeholders. Raw `$ARGUMENTS` preserves the original trailing text, including quotes.

Skill rendering does not execute shell syntax. Text such as ``!`command` `` remains literal Skill text.

If the Skill template contains any supported placeholder, Synergy returns one rendered text body and does not append the trailing input separately. If the template contains no supported placeholder and the user supplied trailing input, Synergy creates a second user-origin text part for that trailing input. Both text parts belong to the same root user turn; attachments are ordered after the rendered text parts. Ordinary Command rendering remains one-based, keeps the highest numbered positional placeholder greedy, supports raw `$ARGUMENTS`, and still uses its existing shell-expression behavior.

## Resources and Security

Loading a Skill through the `skill` tool returns a header with source, scope, compatibility, base directory, warnings, unsupported-field diagnostics, and the Skill body. The model may request one reference at a time with the `reference` parameter.

For file-backed Skills, reference lookup stays inside the Skill base directory. Symlinks or paths that resolve outside the Skill directory are rejected as missing references. Lookup accepts exact names, common text/data extensions when no extension is provided (`.txt`, `.md`, `.mdx`, `.json`, `.yaml`, `.yml`), and files under `references/` by basename or path.

For memory-backed built-in or plugin Skills, references are looked up from the in-memory reference map by exact key, basename, or stem.

Skill roots are trusted only for operations that remain inside the configured root. Reading, writing, executing scripts, or invoking tools outside that boundary still goes through normal Synergy tool permissions and sandbox enforcement.

## Import and Export

Skill import and export use ZIP archives with either `.zip` or `.skill` filenames. `.skill` is the same archive format with a Skill-specific extension.

### Accepted archive shape

An import archive must contain exactly one strict-standard Skill. Two shapes are accepted:

```text
SKILL.md
references/guide.md
assets/data.bin
```

or:

```text
example-skill/SKILL.md
example-skill/references/guide.md
example-skill/assets/data.bin
```

An archive without a canonical `SKILL.md`, with more than one Skill root, or with entries outside the single root is rejected. Import validation always uses the strict Synergy manifest rules. `Skill.md` is not accepted as an import manifest.

When the archive stores `SKILL.md` at the ZIP root, the importer reads the strict manifest name and installs the staged directory under that name. When the archive already has one top-level directory, that directory must validate as the strict Skill root.

### Import limits

| Limit                    |   Value |
| ------------------------ | ------: |
| HTTP request body        |  21 MiB |
| compressed archive bytes |  20 MiB |
| entries                  |   1,000 |
| one expanded file        |  10 MiB |
| total expanded bytes     | 100 MiB |
| inflation ratio          |     100 |

The importer rejects absolute paths, Windows drive paths, parent traversal, backslash paths, duplicate normalized paths, encrypted entries, non-regular entries, symlink metadata, hardlink metadata, invalid expanded sizes, entry-size mismatches, and paths that escape the staging directory.

Extraction is transactional. Synergy extracts into a temporary `.skill-import-*` staging directory beside the destination, validates before final placement, uses a per-Skill install lock, refuses to overwrite an existing Skill directory, and removes staging and owned locks on success or failure.

`POST /skill/import` imports an uploaded archive into `global` scope by default or the requested `project`/`global` scope. `POST /skill/import-url` downloads a bounded archive with redirects disabled and a 15-second timeout, then passes the bytes through the same importer.

A successful import reloads the Skill catalog and cascades to the Command catalog.

### Export contract

`GET /skill/:name/export?format=zip|skill` exports an eligible Skill as an `application/zip` response with a matching `.zip` or `.skill` filename.

A Skill is exportable only when it is file-backed, its entry file is exactly `SKILL.md`, its base directory is inside a trusted canonical Skill root for the active Scope, and strict Synergy validation succeeds with no diagnostics. Built-in, memory-backed, plugin-memory, invalid, and non-standard Skills are not exportable.

Export writes one top-level directory named after the Skill and preserves regular file bytes beneath it. Export refuses symlinks and other non-regular paths. It does not rewrite vendor files; a compatible source Skill that already satisfies the strict standard can be exported unchanged.

## Reload Behavior

`POST /skill/reload` runs the `skill` reload target. The runtime clears scoped Skill state, rescans all live source roots, collects diagnostics, and cascades to the Command catalog so slash-command registration reflects the new invocation flags and Skill bodies.

The runtime file watcher detects Skill changes when a changed file matches an accepted entry name inside a live Skill root. Synergy strict roots watch only `SKILL.md`; lenient roots and the Agent Skills legacy shim also watch `Skill.md`. Detection assigns project or global scope from the root location, debounces by scope, and reloads the union of affected targets.

Editing built-in source files under `packages/synergy/src` still requires restarting the backend process. Runtime reload refreshes runtime state; it does not reload already-imported module code.

## Compatibility Commitment

Synergy preserves discovery of existing Claude, Codex, OpenClaw, and pre-standardization `.agents/skills` entries with their previously accepted entry names. Compatibility Skills load through the same catalog and `skill` tool as native Skills, with diagnostics for fields or legacy normalization Synergy ignores.

Compatibility does not create a second Skill system. The canonical runtime record, invocation flags, permission boundary, resource lookup, import/export validation, reload target, and precedence rules above are the supported Skill contract.
