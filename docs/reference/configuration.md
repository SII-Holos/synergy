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

| File                   | Domain      | Owned configuration                                                                                                                                             |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-general.jsonc`     | General     | schema, UI locale, theme, keybinds, toast, log level, snapshot, username, layout, embedding, rerank                                                             |
| `10-models.jsonc`      | Models      | default and role models, role variants, quick switcher                                                                                                          |
| `20-providers.jsonc`   | Providers   | provider definitions, catalog, enabled/disabled providers                                                                                                       |
| `30-library.jsonc`     | Library     | Memory, Experience, learning, recall, and autonomy settings                                                                                                     |
| `40-mcp.jsonc`         | MCP         | MCP servers and MCP defaults                                                                                                                                    |
| `50-plugins.jsonc`     | Plugins     | installed specs, plugin settings, approval, runtime limits, marketplace                                                                                         |
| `60-agents.jsonc`      | Agents      | default agent, agent/external-agent definitions, instruction discovery, categories                                                                              |
| `70-commands.jsonc`    | Commands    | configured command definitions                                                                                                                                  |
| `80-permissions.jsonc` | Permissions | permissions, tool visibility, control profile, sandbox, SmartAllow                                                                                              |
| `90-channels.jsonc`    | Channels    | Channel provider and account configuration                                                                                                                      |
| `100-holos.jsonc`      | Holos       | Holos connection and enterprise endpoint settings                                                                                                               |
| `110-email.jsonc`      | Email       | email account and delivery settings                                                                                                                             |
| `120-runtime.jsonc`    | Runtime     | server, timeout, Cortex scheduling, watcher, formatter, LSP, questions, compaction, experimental, and observability settings                                    |
| `130-github.jsonc`     | GitHub      | GitHub App outbound polling integration (master enable, watched repos, polling, event types, CI thresholds, classifier/proposal, fix workflow, review workflow) |

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

## Interface language

`locale` is a global General preference with three accepted values:

```jsonc
{
  "locale": "system", // system | en | zh-CN
}
```

`system` is the default when the field is absent. A Chinese system or browser language resolves to Simplified Chinese; unsupported system languages resolve to English. The preference is installation-wide user interface state and does not follow project Scope overrides. It changes Web and Desktop product chrome only; it does not select the language used by agents or model replies.

The frontend may mirror the value locally to choose a catalog before the server responds, but `00-general.jsonc` remains authoritative after global configuration synchronization. Locale changes are client-side and do not restart the server or providers.

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

### Live provider model discovery

Providers that support live model catalog discovery (e.g. `openai-codex`, `github-copilot`) fetch account-visible model slugs at resolution time. Each provider profile may supply a `modelCatalogIdentity()` function that derives a non-secret account identity — for Codex, the runtime base URL plus the ChatGPT account ID — from the authenticated credential. This identity, rather than the raw credential, is used as the cache key for live results.

The bounded in-memory `lastKnownGood` map stores the most recent successful live entry set per `(providerID, identity)` key, retaining at most 100 entries total across all unique provider/identity pairs and evicting the least recently written entry when full. On a successful live fetch the result is stored as the new LKG and the provider is marked `verified`. If a live fetch fails, the provider is marked `fallback` and the previous LKG entries are used if available. The overall resolution cache uses a normal 1-hour TTL when all live fetches succeed and a short 60-second retry TTL when any provider degraded.

LKG is purely in-memory: restart or `ProviderCatalog.reset()` discards all entries. Degraded results automatically retry on the next resolution cycle. The `liveDiscoveryStatus(providerID)` function exposes the current `"verified"` or `"fallback"` state per provider.

Static provider catalogs and live account-backed model discovery use separate cache entries. Authentication health is driven by real provider requests rather than startup or periodic probes.

### Model variants and role variants

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility, so custom provider aliases retain correct behavior.

`ProviderTransform.variants()` applies transport-specific rules for third-party services on Anthropic and OpenAI-compatible wiring. Kimi K3 models on direct Anthropic transport expose catalog-declared `low`, `high`, and `max` variants. `low` and `high` map to Anthropic `effort`; `max` omits `effort` because Kimi's service default is already `max` and the locked Anthropic SDK accepts only `low`, `medium`, or `high`. Selecting no variant likewise uses Kimi's server-side `max` default. Kimi K2.x models remain provider-managed and receive no automatic Anthropic thinking variants. MiniMax M2.x models on direct Anthropic transport likewise produce no variants because reasoning is always on. MiniMax M3 on direct Anthropic transport exposes only a `max` variant mapped to `thinking: { type: "adaptive" }`; without it, reasoning defaults to off. MiniMax models on direct OpenAI-compatible Chat transport receive no `reasoningEffort` variants because that endpoint does not support `reasoning_effort`.

`role_variant` selects a variant name for a model role only when the resolved model exposes that same variant. If a provider-managed reasoning model exposes no automatic variants, `role_variant: { "thinking": "max" }` does not synthesize provider options; the request uses the provider's default reasoning behavior. Explicit model `variants` configured under a provider model are merged after automatic defaults, so they can add or override named variants for that model.

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

## GitHub Integration

Synergy polls GitHub repositories outbound using GitHub App installation tokens. It requires no public inbound listener. Events are synthesized from REST API responses and processed through three independent pipelines: shadow-only diagnostic proposals, opt-in autonomous fix delivery, and opt-in automatic PR review and test. The configuration is owned by the GitHub domain (`130-github.jsonc`) and all pipelines are disabled by default.

```jsonc
{
  "github": {
    "enabled": true,
    "watchedRepositories": ["owner/repo"],
    "eventTypes": ["issues.opened", "workflow_run.completed"],
    "ciFailureThreshold": 3,
    "ciFailureWindowHours": 24,
    "classifierEnabled": false,
    "proposalEnabled": false,
    "modelBudgetNano": { "maxTokens": 256, "maxCost": 0.001 },
    "modelBudgetProposal": { "maxTokens": 2048, "maxCost": 0.02 },
    "polling": {
      "enabled": true,
      "intervalMs": 60000,
      "overlapWindowMs": 300000,
      "pageSize": 100,
      "maxPages": 30,
    },
    "fixWorkflow": {
      "enabled": false,
      "repositoryMapping": { "owner/repo": "/path/to/local/repo" },
      "maxRetries": 3,
      "timeoutMs": 900000,
      "locatorAgent": "github-issue-locator",
      "agent": "github-fix-coder",
      "pushBranchPrefix": "synergy/fix/",
    },
    "reviewWorkflow": {
      "enabled": false,
      "repositoryMapping": { "owner/repo": "/path/to/local/repo" },
      "eventTypes": ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
      "reviewCommands": ["bun test", "bun run typecheck"],
      "maxRetries": 3,
      "timeoutMs": 900000,
      "agent": "github-review-agent",
      "publishReviewComment": true,
      "publishCheckRun": true,
    },
  },
}
```

### Common settings

| Field                         | Required | Default                                       | Description                                                                               |
| ----------------------------- | -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `github.enabled`              | no       | `false`                                       | Master enable for all GitHub integration pipelines                                        |
| `github.watchedRepositories`  | no       | —                                             | Repository full-name allowlist (e.g. `["owner/repo"]`). Absent = any repository accepted. |
| `github.eventTypes`           | no       | `["issues.opened", "workflow_run.completed"]` | GitHub event types to process through the gate and shadow pipeline                        |
| `github.ciFailureThreshold`   | no       | `3`                                           | Consecutive workflow failures before triggering a CI proposal                             |
| `github.ciFailureWindowHours` | no       | `24`                                          | Sliding window in hours for counting CI failures                                          |
| `github.classifierEnabled`    | no       | `false`                                       | Enable the sessionless nano classifier for ambiguous issues                               |
| `github.proposalEnabled`      | no       | `false`                                       | Enable Cortex-based proposal generation for gated events and classified bugs              |
| `github.modelBudgetNano`      | no       | `{ "maxTokens": 256, "maxCost": 0.001 }`      | Token and cost budget for the classifier model call                                       |
| `github.modelBudgetProposal`  | no       | `{ "maxTokens": 2048, "maxCost": 0.02 }`      | Token and cost budget for each proposal Cortex task                                       |

The `modelBudgetNano.maxTokens` cap is passed as `maxOutputTokens` to the classifier LLM call. The `modelBudgetProposal.maxTokens` cap is passed as `maxOutputTokens` to the proposal Cortex task. After the call completes, actual usage is measured against both the token and cost limits; exceeding either discards the result.

### polling (outbound REST API polling)

When `github.enabled` and `polling.enabled` are both true, Synergy polls each known repository's GitHub REST API on a configurable interval using ephemeral GitHub App installation tokens. At least one `watchedRepositories` entry or one `repositoryMapping` entry in fix/review workflows is required.

| Field                     | Required | Default  | Description                                                                                                  |
| ------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `polling.enabled`         | no       | `true`   | Enable outbound API polling; set to false to suppress all API calls while keeping delivery processing active |
| `polling.intervalMs`      | no       | `60000`  | Milliseconds between poll cycles per repository; accepted range 15000–300000 (15 s to 5 min)                 |
| `polling.overlapWindowMs` | no       | `300000` | Milliseconds to extend the `since` query backward for overlap safety; accepted range 0–600000 (10 min)       |
| `polling.pageSize`        | no       | `100`    | Results per API page; accepted range 1–100                                                                   |
| `polling.maxPages`        | no       | `30`     | Maximum pages per query; exceeding the limit aborts with an error; accepted range 1–100                      |

### fixWorkflow (autonomous issue fix delivery)

When `fixWorkflow.enabled` is true, `issues.opened` events that match the bug signal regex are routed through an autonomous fix pipeline: locate root cause, post a proposed-fix issue comment, implement the fix in an isolated worktree, commit, push a branch, open a pull request, and post a completion comment. The shadow proposal pipeline is bypassed for the same event.

`fixWorkflow.repositoryMapping` maps repository full names to local project directory paths. It is required when enabled. An unmapped repository is silently ignored by the gate.

| Field                           | Required     | Default                  | Description                                                                                          |
| ------------------------------- | ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `fixWorkflow.enabled`           | no           | `false`                  | Enable the autonomous issue fix delivery workflow                                                    |
| `fixWorkflow.repositoryMapping` | when enabled | `{}`                     | Map of repository full name → local project directory (e.g. `{"owner/repo": "/home/projects/repo"}`) |
| `fixWorkflow.maxRetries`        | no           | `3`                      | Maximum retries before permanent failure; accepted range is 0–20                                     |
| `fixWorkflow.timeoutMs`         | no           | `900000` (15 min)        | Timeout per locator and coder Cortex task                                                            |
| `fixWorkflow.locatorAgent`      | no           | `"github-issue-locator"` | Hidden agent used for root-cause location                                                            |
| `fixWorkflow.agent`             | no           | `"github-fix-coder"`     | Hidden agent used for fix implementation                                                             |
| `fixWorkflow.pushBranchPrefix`  | no           | `"synergy/fix/"`         | Prefix for pushed fix branches; the suffix is `issue-<number>-<slug>`                                |

### reviewWorkflow (automatic PR review and test)

When `reviewWorkflow.enabled` is true, `pull_request.opened`, `pull_request.reopened`, and `pull_request.synchronize` events fetch the PR head and base SHAs, run a read-only reviewer in an isolated worktree, execute configured verification commands, and optionally publish a pull request review comment and a check run.

`reviewWorkflow.repositoryMapping` maps repository full names to local project directory paths. It is required when enabled. An unmapped repository is silently ignored.

| Field                                 | Required     | Default                                                                        | Description                                                                              |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `reviewWorkflow.enabled`              | no           | `false`                                                                        | Enable the automatic PR review workflow                                                  |
| `reviewWorkflow.repositoryMapping`    | when enabled | `{}`                                                                           | Map of repository full name → local project directory                                    |
| `reviewWorkflow.eventTypes`           | no           | `["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"]` | Pull request event types to review                                                       |
| `reviewWorkflow.reviewCommands`       | no           | `["bun test", "bun run typecheck"]`                                            | Commands executed with the review agent's sandboxed Bash access in the isolated worktree |
| `reviewWorkflow.maxRetries`           | no           | `3`                                                                            | Maximum retries before permanent failure; accepted range is 0–20                         |
| `reviewWorkflow.timeoutMs`            | no           | `900000` (15 min)                                                              | Timeout for the review Cortex task                                                       |
| `reviewWorkflow.agent`                | no           | `"github-review-agent"`                                                        | Hidden agent used for defect-first review                                                |
| `reviewWorkflow.publishReviewComment` | no           | `true`                                                                         | Post a pull request review comment with findings                                         |
| `reviewWorkflow.publishCheckRun`      | no           | `true`                                                                         | Create a check run on the head SHA with pass/fail conclusion                             |

### GitHub App credentials

The integration uses GitHub App authentication for all REST API calls and git push operations. These credentials are env-only and never appear in config:

- `SYNERGY_GITHUB_APP_ID` — the GitHub App ID used to sign installation-access JWTs
- `SYNERGY_GITHUB_APP_PRIVATE_KEY` — the RSA private key for the GitHub App; `\n` sequences in an environment variable are automatically converted to literal newlines

Polling requires these credentials. The fix and review workflows also require them. There is no webhook secret, no inbound webhook route, and no CORS bypass for GitHub.

See [GitHub Integration](../architecture/github-shadow.md) for the polling architecture and processing pipeline.

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

| Variable                         | Effect                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SYNERGY_HOME`                   | Change the parent of the complete `.synergy/` installation home                                                      |
| `SYNERGY_CONFIG`                 | Merge one additional config file after global config                                                                 |
| `SYNERGY_CONFIG_CONTENT`         | Merge inline JSON after `SYNERGY_CONFIG`                                                                             |
| `SYNERGY_CONFIG_DIR`             | Add a high-precedence config/agent/command/skill/instruction root                                                    |
| `SYNERGY_PERMISSION`             | Merge a final JSON permission overlay                                                                                |
| `SYNERGY_CWD`                    | Override the launch/current directory used by source and embedded flows                                              |
| `SYNERGY_CLIENT`                 | Identify the client in the runtime user agent and client-specific tool exposure                                      |
| `SYNERGY_GIT_BASH_PATH`          | Select Git Bash on Windows when automatic shell discovery is unsuitable                                              |
| `SYNERGY_GITHUB_APP_ID`          | GitHub App ID for installation token signing; required for polling and when fixWorkflow or reviewWorkflow is enabled |
| `SYNERGY_GITHUB_APP_PRIVATE_KEY` | GitHub App RSA private key for JWT creation; `\n` sequences are converted to literal newlines                        |

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

| Variable                             | Effect                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `SYNERGY_EXPERIMENTAL=1`             | Enable the grouped experimental behaviors that explicitly consult it                         |
| `SYNERGY_EXPERIMENTAL_OXFMT=1`       | Allow the experimental `oxfmt` formatter path                                                |
| `SYNERGY_EXPERIMENTAL_LSP_TY=1`      | Prefer the experimental `ty` Python language server over Pyright                             |
| `SYNERGY_EXPERIMENTAL_LSP_TOOL=1`    | Register the experimental direct LSP tool                                                    |
| `SYNERGY_DISABLE_MESSAGE_CACHE=1`    | Bypass the loop-scoped model-working-set cache and reconstruct it from storage on every read |
| `SYNERGY_VERIFY_MESSAGE_CACHE=1`     | Compare the cached model working set with storage and fall back when they diverge            |
| `SYNERGY_SESSION_CACHE_MAX_BYTES`    | Set the aggregate and per-session model-working-set cache byte budget; defaults to 256 MiB   |
| `SYNERGY_DISABLE_LSP_REAP=1`         | Keep idle LSP clients instead of reaping and recreating them on demand                       |
| `SYNERGY_LSP_MAX_CLIENTS_PER_SERVER` | Set the per-language-server client cap; the minimum is one and the default is two            |

Experimental and diagnostic variables are not persisted preferences. Use them to isolate behavior, then fix or configure the owning subsystem instead of relying on them as permanent compatibility layers. Performance-specific environment variables are listed in [Performance Observability](../operations/performance-observability.md); Desktop build/release variables are listed in [Desktop Release](../operations/desktop-release.md).
