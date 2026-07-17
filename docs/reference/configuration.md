# Configuration Reference

Synergy uses JSONC domain files. Global and project configuration share the same domain names so one setting has one owning file.

## Locations

Global configuration:

```text
~/.synergy/config/synergy.d/
```

Project configuration for an explicitly selected project Scope:

```text
<project>/.synergy/synergy.d/
```

`SYNERGY_HOME=/path` changes the home prefix, so the global root becomes `/path/.synergy/`. It redirects data, auth, config, logs, cache, schema, daemon state, and locks together.

Use `synergy config path` to print the active global roots.

## Domains

| File                   | Domain      | Owned configuration                                                                                                         |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `00-general.jsonc`     | General     | schema, theme, keybinds, toast, log level, snapshot, username, layout, embedding, rerank                                    |
| `10-models.jsonc`      | Models      | default and role models, role variants, quick switcher                                                                      |
| `20-providers.jsonc`   | Providers   | provider definitions, catalog, enabled/disabled providers                                                                   |
| `30-library.jsonc`     | Library     | Memory, Experience, learning, recall, and autonomy settings                                                                 |
| `40-mcp.jsonc`         | MCP         | MCP servers and MCP defaults                                                                                                |
| `50-plugins.jsonc`     | Plugins     | installed specs, plugin settings, approval, runtime limits, marketplace                                                     |
| `60-agents.jsonc`      | Agents      | default agent, agent/external-agent definitions, instruction discovery, categories                                          |
| `70-commands.jsonc`    | Commands    | configured command definitions                                                                                              |
| `80-permissions.jsonc` | Permissions | permissions, tool visibility, control profile, sandbox, SmartAllow                                                          |
| `90-channels.jsonc`    | Channels    | Channel provider and account configuration                                                                                  |
| `100-holos.jsonc`      | Holos       | Holos connection and enterprise endpoint settings                                                                           |
| `110-email.jsonc`      | Email       | email account and delivery settings                                                                                         |
| `120-runtime.jsonc`    | Runtime     | server, timeout, Cortex scheduling, watcher, formatter, LSP, questions, compaction, experimental and observability settings |

Global loading validates each canonical file against the keys owned by its domain. Project `synergy.d` fragments are loaded in numeric filename order and merged into the resolved config. Use the canonical files above for predictable ownership and UI editing.

Monolithic `synergy.json` and `synergy.jsonc` files are migration inputs, not active runtime config paths. Startup migrates legacy global and project files into domain files and archives the originals.

## Precedence

From lowest to highest precedence, a scoped config is assembled from:

1. authenticated organization `/.well-known/synergy` config
2. global domain configuration
3. `SYNERGY_CONFIG` file
4. `SYNERGY_CONFIG_CONTENT` inline JSON
5. the selected project's `.synergy/synergy.d` fragments
6. `SYNERGY_CONFIG_DIR` fragments
7. explicit permission and compaction environment overrides

Objects merge deeply. Later scalar values win. `plugin`, `instructions`, and `project_doc_fallback_filenames` are combined and deduplicated rather than simply replaced; plugin specs with the same identity resolve to the later definition.

Remote well-known config is cached for ten minutes and acts only as a base: local config can override it. A failed remote fetch is skipped with a warning.

## JSONC, Schema, and References

Files allow comments and trailing commas. On startup, the installed config schema is copied to:

```text
~/.synergy/schema/config.schema.json
```

Editors can reference its `file:` URL through `$schema`. The Settings UI and config APIs write the owning domain rather than reconstructing a monolithic file.

String values support two substitutions:

- `{env:NAME}` inserts an environment variable; an unset variable becomes an empty string with a warning
- `{file:path}` inserts trimmed file content, resolved relative to the config file (or `~/` / absolute paths)

Use file or environment references for secrets instead of checking credentials into project config. Provider, MCP, Holos, and plugin auth stores remain separate from ordinary JSONC configuration.

Malformed JSONC is a startup/config error with line and column information. When the root remains valid but individual schema sections are invalid, Synergy can drop those sections, warn, and retain usable config; do not rely on this recovery as validation.

## Agents and Commands from Markdown

In addition to JSONC maps, Synergy discovers Markdown definitions under global/configured roots and the selected project:

```text
agent/**/*.md
agents/**/*.md
command/**/*.md
commands/**/*.md
```

Frontmatter defines metadata and the Markdown body becomes the prompt or command template. Nested agent paths become names such as `review/security`.

## Instruction Files

Automatic instruction discovery is distinct from agent definitions. For each directory from the project Scope root to the current working directory, Synergy selects the first existing file in this order:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. configured `project_doc_fallback_filenames`
4. `CLAUDE.md`
5. `CONTEXT.md`

At most one automatic file is selected per directory. The default maximum is 32 KiB per automatically discovered file; `project_doc_max_bytes: 0` disables automatic discovery.

Global instructions prefer `~/.synergy/config/AGENTS.override.md`, then `AGENTS.md`. Settings → Personalize → Custom Instructions displays this effective global content. Saving always writes `AGENTS.override.md` and preserves `AGENTS.md`; clearing the editor or choosing Reset removes the override and restores the primary file. The editor and API enforce a 32 KiB UTF-8 limit.

Global instructions are loaded before project files. Project instructions then load from the Scope root toward the current working directory so more specific files appear later in the assembled prompt. Claude compatibility can add `~/.claude/CLAUDE.md` unless disabled. `SYNERGY_CONFIG_DIR` can provide its own override or primary file.

The `instructions` array appends explicit files, globs, or HTTP(S) URLs after automatic discovery. Automatically selected paths are not duplicated. URL reads time out after five seconds.

## Providers and Authentication

Model names use `provider/model`. Provider definitions and model defaults live in config; credentials live in auth storage.

- `openai` is the OpenAI Platform API-key provider.
- `openai-codex` uses ChatGPT/Codex OAuth device-code credentials and the Codex backend.

Do not copy credentials or billing assumptions between them. Use `synergy auth` or the Settings UI to manage auth.

Static provider catalogs and live account-backed model discovery use separate cache entries. Live discovery can expose account-visible model slugs that are not present in a static catalog. Authentication health is driven by real provider requests rather than startup or periodic probes.

## Control Profiles and Sandbox

`controlProfile` selects `guarded`, `autonomous`, or `full_access`. Session and agent settings can override the global value through the resolution order documented in [Execution Boundaries](../architecture/execution-boundaries.md).

`permission` adds capability/tool rules; `sandbox` selects backend behavior and fallback; `smartAllow` enables constrained high-confidence resolution of eligible decisions. A permissive permission rule does not make a hidden tool visible, and sandbox configuration does not replace the authorization decision.

## Server Settings

The `server` object supports `hostname`, `port`, `mdns`, and additional CORS origins. Explicit CLI network flags override configured values. The managed background service snapshots these values into its service definition, so restart the service after changing them.

Binding a server beyond loopback exposes it to other hosts. Configure CORS and the surrounding network boundary deliberately.

## Code Checks

Post-write language-server diagnostic policy. Controls the diagnostics returned after write, edit, save_file, and revise_file complete. All fields are owned by `120-runtime.jsonc`.

```jsonc
{
  "lspWriteDiagnostics": true,
  "lspDiagnostics": {
    "severity": "error",
    "scope": "project",
  },
}
```

`lspWriteDiagnostics` (boolean, optional, default `true`) is the master toggle. Setting it to `false` disables all post-write diagnostic output.

`lspDiagnostics` (object, optional) sets the severity filter and reporting scope:

- `severity` — `"error"` (default) reports only errors; `"warning"` includes both errors and warnings.
- `scope` — `"project"` (default) reports matching diagnostics across the project; `"file"` reports matching diagnostics for the edited file only; `"delta"` reports added, resolved, and unchanged diagnostics for the edited file relative to the pre-write snapshot.

When `lspDiagnostics` is absent, or when either nested field is omitted, missing values inherit `severity: "error"` and `scope: "project"`. Config changes are live-applied and do not restart LSP servers.

The Web Settings Code Checks page exposes these three fields: an Include Diagnostics toggle that disables the Diagnostic Severity and Diagnostic Scope selectors when off.

## Embedding

Embedding configuration is owned by the General domain (`00-general.jsonc`). Two modes are supported: local (default, zero-config) and remote (requires an API key).

### Local (default)

When `embedding.apiKey` is absent, Synergy uses the bundled `Xenova/all-MiniLM-L6-v2` model running locally. The model downloads lazily on first use rather than at startup. Run `synergy embed download` to fetch the assets ahead of time.

```jsonc
{
  "embedding": {
    "local": {
      "source": "huggingface",
    },
  },
}
```

| Field                        | Required                    | Default         | Description                                                                                                                                                                     |
| ---------------------------- | --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedding.local.source`     | no                          | `"huggingface"` | Download source: `"huggingface"` downloads from Hugging Face Hub, `"hf-mirror"` uses the HF Mirror (`https://hf-mirror.com/`), and `"custom"` uses a user-supplied `remoteHost` |
| `embedding.local.remoteHost` | when `source` is `"custom"` | —               | Public HTTPS origin with no credentials, path, query, or hash. Local, private, and loopback hostnames are rejected; the field is ignored for built-in sources.                  |

The model ID, quantization dtype, and ONNX cache directory are not configurable.

### Remote

When `embedding.apiKey` is set, Synergy queries an embedding API instead of using the local model. The remote provider defaults to SiliconFlow with `Qwen/Qwen3-Embedding-8B`.

```jsonc
{
  "embedding": {
    "apiKey": "sk-...",
    "baseURL": "https://api.siliconflow.cn/v1",
    "model": "Qwen/Qwen3-Embedding-8B",
  },
}
```

| Field               | Required | Default                           | Description                              |
| ------------------- | -------- | --------------------------------- | ---------------------------------------- |
| `embedding.apiKey`  | yes      | —                                 | API key for the embedding service        |
| `embedding.baseURL` | no       | `"https://api.siliconflow.cn/v1"` | OpenAI-compatible embedding API base URL |
| `embedding.model`   | no       | `"Qwen/Qwen3-Embedding-8B"`       | Model name sent to the embedding API     |

Use `synergy config embedding` for an interactive setup or the Web Settings Embedding page.

## Cortex Scheduling

The global Runtime domain controls the process-wide Cortex subagent maximum:

```jsonc
{
  "cortex": {
    "maxConcurrentTasks": 8,
  },
}
```

`cortex.maxConcurrentTasks` must be a positive integer and defaults to `8`. Changes made through global Settings or the global configuration API apply without restarting the runtime. Lowering the value leaves running tasks untouched and queues new work until capacity is available; raising it releases eligible queued work. Project configuration does not control this process-global scheduler.

Memory pressure may recommend a lower value, shown in Settings and the Cortex concurrency status API, but the recommendation never overrides the effective maximum. `SYNERGY_CORTEX_GLOBAL_CONCURRENCY` is a process-local positive-integer override with higher precedence than the global config value; while it is set, Settings reports the environment-managed value instead of editing it.

## Config Import

`synergy config import <source>` imports JSON or JSONC configuration from a local file, a URL, or pasted text in the Web Settings UI. Sources are limited to 1 MiB; URL fetches time out after 15 seconds and reject redirects. Direct plan/apply API requests are limited to a 2 MiB JSON envelope.

### Import flow

1. **Load** — The source is parsed as JSONC and validated against the config schema. Unrecognized keys produce a validation error; only JSONC syntax errors include line and column information.
2. **Plan** — The loaded config is split by domain, each owning-domain fragment is merged into the current config at the target scope, and value-level changes (add, modify, remove) are produced. Conflicts are classified and hardcoded secrets are flagged as warnings without blocking the import. A revision hash captures the plan identity.
3. **Apply** — After review and confirmation, each changed domain file is written atomically with a per-scope exclusive lock, staged writes, and rollback on failure. JSONC comments in existing files are preserved.
4. **Reload** — Committed files trigger a runtime config reload. Reload failure does not roll back committed config files; if the runtime reports restart-required targets, restart the server to pick them up.

### CLI options

```bash
synergy config import <source>
  --scope global|project  # default: global; project requires an active project scope
  --only <domain>         # import only the named domain; repeatable
  --mode merge|replace-domain|append  # per-domain merge policy override
  --dry-run               # show the plan without writing files
  --force                 # apply even when the revision does not match (stale plan)
  --yes, -y               # skip the confirmation prompt
```

All domains are importable and default to `merge` mode. A stale plan (revised config after planning) is rejected unless `--force` is supplied.

`merge` recursively merges objects and replaces ordinary arrays, `replace-domain` replaces the complete selected domain, and `append` recursively merges objects while appending arrays in source order. Imported scalar values override existing scalar values in both merge modes.

### Web Settings Import

The Settings Import surface accepts file upload, URL fetch, or pasted JSON/JSONC. It supports explicit Global/Project target selection, a project chooser for project imports, domain-level selection with a re-review gate when the domain set changes, value-level current-versus-imported display, diagnostic warnings, stale-plan detection with a refresh action, and a reload-result summary after apply.

## Config Editing

The Web Settings surface, domain APIs, and CLI all use the same domain ownership registry. Manual edits should preserve that ownership so reload targets and conflict previews remain meaningful.

## Process Environment

Domain files are the durable configuration contract. Environment variables are process-local overrides for embedding Synergy, source development, CI, experiments, or diagnosis; a managed service receives only the environment captured by its service definition.

### Location and merge inputs

| Variable                 | Effect                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `SYNERGY_HOME`           | Change the parent of the complete `.synergy/` installation home                 |
| `SYNERGY_CONFIG`         | Merge one additional config file after global config                            |
| `SYNERGY_CONFIG_CONTENT` | Merge inline JSON after `SYNERGY_CONFIG`                                        |
| `SYNERGY_CONFIG_DIR`     | Add a high-precedence config/agent/command/skill/instruction root               |
| `SYNERGY_PERMISSION`     | Merge a final JSON permission overlay                                           |
| `SYNERGY_CWD`            | Override the launch/current directory used by source and embedded flows         |
| `SYNERGY_CLIENT`         | Identify the client in the runtime user agent and client-specific tool exposure |
| `SYNERGY_GIT_BASH_PATH`  | Select Git Bash on Windows when automatic shell discovery is unsuitable         |

### Network and discovery overrides

| Variable                                      | Effect                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SYNERGY_ARXIV_API_URL`                       | Replace the built-in arXiv search service base URL                                        |
| `SYNERGY_SEARXNG_URL`                         | Replace the built-in Web search service base URL                                          |
| `SYNERGY_DISABLE_MODELS_FETCH=1`              | Disable the models catalog refresh                                                        |
| `SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH=true` | Use the last verified provider catalog cache instead of fetching its signed remote source |
| `SYNERGY_DISABLE_LSP_DOWNLOAD=1`              | Prevent automatic language-server downloads                                               |

### Compatibility and behavior overrides

| Variable                               | Effect                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `SYNERGY_DISABLE_AUTOCOMPACT=1`        | Force `compaction.auto` off for this process                                            |
| `SYNERGY_DISABLE_PRUNE=1`              | Force context tool-output pruning off                                                   |
| `SYNERGY_DISABLE_CLAUDE_CODE=1`        | Disable both Claude instruction and skill compatibility discovery                       |
| `SYNERGY_DISABLE_CLAUDE_CODE_PROMPT=1` | Omit `~/.claude/CLAUDE.md` from global instruction discovery                            |
| `SYNERGY_DISABLE_CLAUDE_CODE_SKILLS=1` | Omit Claude-compatible global and project skills                                        |
| `SYNERGY_DISABLE_FILEWATCHER=1`        | Disable the default project file watcher for diagnosis                                  |
| `SYNERGY_CORTEX_GLOBAL_CONCURRENCY`    | Override the process-global Cortex subagent concurrency maximum with a positive integer |
| `SYNERGY_FAKE_VCS`                     | Override detected Scope VCS type for tests and controlled embedding                     |

### Experimental and diagnostic escape hatches

| Variable                             | Effect                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `SYNERGY_EXPERIMENTAL=1`             | Enable the grouped experimental behaviors that explicitly consult it              |
| `SYNERGY_EXPERIMENTAL_OXFMT=1`       | Allow the experimental `oxfmt` formatter path                                     |
| `SYNERGY_EXPERIMENTAL_LSP_TY=1`      | Prefer the experimental `ty` Python language server over Pyright                  |
| `SYNERGY_EXPERIMENTAL_LSP_TOOL=1`    | Register the experimental direct LSP tool                                         |
| `SYNERGY_DISABLE_MESSAGE_CACHE=1`    | Bypass the loop-scoped session-message cache and read storage directly            |
| `SYNERGY_VERIFY_MESSAGE_CACHE=1`     | Compare cached messages with disk and fall back when they diverge                 |
| `SYNERGY_SESSION_CACHE_MAX_BYTES`    | Set the message-cache byte budget; the default is 256 MiB                         |
| `SYNERGY_DISABLE_LSP_REAP=1`         | Keep idle LSP clients instead of reaping and recreating them on demand            |
| `SYNERGY_LSP_MAX_CLIENTS_PER_SERVER` | Set the per-language-server client cap; the minimum is one and the default is two |

Experimental and diagnostic variables are not persisted preferences. Use them to isolate behavior, then fix or configure the owning subsystem instead of relying on them as permanent compatibility layers. Performance-specific environment variables are listed in [Performance Observability](../operations/performance-observability.md); Desktop build/release variables are listed in [Desktop Release](../operations/desktop-release.md).
