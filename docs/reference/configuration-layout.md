# Configuration Layout

The field-level reference is generated at [configuration.md](configuration.md); this document explains configuration layout and semantics.

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

Global loading validates each canonical file against the keys owned by its domain. Project `synergy.d` fragments are loaded in numeric filename order and merged into the resolved config. Use the canonical files above for predictable ownership and UI editing.

Clarus accounts live in the Channel domain and reuse Holos credentials:

```jsonc
{
  "channel": {
    "clarus": {
      "type": "clarus",
      "accounts": {
        "<holos-agent-id>": {
          "enabled": false,
          "agent": "synergy",
        },
      },
    },
  },
}
```

Holos login creates the matching Clarus Channel account when it is absent and preserves explicit account settings. A versioned Holos migration provisions the same disabled account for an existing active identity. There is no top-level `clarus` domain or Clarus workspace-root setting.

Monolithic `synergy.json` and `synergy.jsonc` files are migration inputs, not active runtime config paths. Startup migrates legacy global and project files into domain files and archives the originals.

### Execution isolation

The optional `execution` object in `120-runtime.jsonc` controls bounded Agent and tool scheduling:

```jsonc
{
  "execution": {
    "agentWorkers": 4,
    "agentWorkerMinIdle": 0,
    "agentWorkerIdleTimeoutMs": 60000,
    "agentQueueMax": 256,
    "agentQueueMaxMb": 256,
    "agentWorkerMaxTurns": 64,
    "agentWorkerMaxRssMb": 3072,
    "agentWorkerMaxHeapMb": 2048,
    "agentWorkerIdleBaselineRecycle": true,
    "agentWorkerIdleBaselineRssGrowthMb": 256,
    "agentWorkerIdleBaselineExternalGrowthMb": 128,
    "agentCancelGraceMs": 5000,
    "agentHeartbeatTimeoutMs": 45000,
    "policyWorkers": 2,
    "policyQueueMax": 256,
    "policyQueueMaxMb": 64,
    "policyTimeoutMs": 1000,
    "policyWorkerMaxRequests": 512,
    "policyWorkerMaxRssMb": 512,
    "policyWorkerMaxHeapMb": 256,
    "policyCancelGraceMs": 25,
    "policyHeartbeatTimeoutMs": 15000,
    "toolConcurrency": 16,
    "toolQueueMax": 512,
    "toolQueueMaxMb": 128,
    "toolCancelGraceMs": 3000,
    "toolExecutorConcurrency": {
      "local_process": 8,
      "file": 16,
      "plugin": 8,
      "mcp": 16,
      "browser": 8,
      "link": 8,
      "control_plane": 16,
    },
  },
}
```

`agentWorkers` is the maximum Agent-turn concurrency, not an eagerly allocated pool size. It defaults to the smaller of four or available CPUs minus one, with a minimum of one and a validated maximum of 64. The pool starts workers on demand, keeps `agentWorkerMinIdle` idle workers warm (default 0), and retires excess workers after `agentWorkerIdleTimeoutMs` (default 60 seconds). `agentWorkerMinIdle` cannot exceed the effective `agentWorkers` limit.

`agentWorkers` can be changed from Settings → Agents or the Runtime domain while the global runtime is running. Increasing it raises the ceiling and admits queued demand without eagerly filling unused capacity. Decreasing it releases excess idle workers immediately, while excess active workers finish their current turns before retiring.

Agent request and event-frame protocol bounds are fixed safety invariants rather than configuration. RSS and heap-used watermarks are enforced from worker heartbeats as well as normal turn completion; the heartbeat timeout is constrained to 30-300 seconds so it cannot undercut the worker heartbeat cadence. `agentWorkerMaxRssMb` and `agentWorkerMaxHeapMb` are hard limits, defaulting to 3072 MiB and 2048 MiB. Each soft recycle watermark is fixed at half its hard limit. Crossing a soft watermark during an active turn requests a full collection inside that worker; if the post-collection sample remains above soft but below hard, the worker finishes the turn and recycles only after `released`. Hard RSS remains an immediate last-resort limit, while hard heap terminates only when a full-collection sample is still over the limit. Released workers report RSS, heap, external, and array-buffer memory after stream disposal and can be recycled without interrupting a turn. Linux performs one coalesced full collection at that release boundary by default, and `agentWorkerIdleBaselineRecycle` recycles a worker whose post-release RSS or external memory grows beyond its warm minimum by the configured thresholds. Baseline recycling defaults on for Linux and off elsewhere; absolute watermarks and turn-count recycling remain independent.

`policyWorkers` defaults to the smaller of two or available CPUs minus one, with a minimum of one and a maximum of 16. Global-runtime startup begins prewarming without making server availability depend on the worker handshake. A cold classification waits at most ten seconds for readiness; after readiness, `policyTimeoutMs` covers queueing, transfer, and classification. Policy requests are limited to 16 MiB and transferred in 1 MiB acknowledged chunks; those protocol limits are fixed. Expiry terminates the owning worker and makes the enforcement gate return an immediate conservative denial rather than an approval prompt. The queue, aggregate bytes, request-count recycling, RSS/heap watermarks, heartbeat timeout, and shutdown grace are independently configurable.

Global and per-executor tool concurrency are capped at 512. Tool executor limits are additional ceilings below `toolConcurrency`; omitted executor limits retain their defaults. Runtime shutdown stops new Agent turns, Policy classifications, and ToolTasks first, aborts active work, and bounds ToolTask drain time with `toolCancelGraceMs`. Except for the live-applied `agentWorkers` capacity, execution settings are read at global-runtime startup and require a runtime restart.

### Plugin runtime limits

`pluginRuntimePolicy.limits` in `50-plugins.jsonc` configures the plugin process runtime. Five timeout keys are host-configurable and default to `120000` ms:

- `agentCallMaxRuntimeMs` — maximum duration of a plugin `agent.call`/`agent.start` model invocation
- `hookTimeoutMs` — per-handler timeout for plugin hook points
- `contributionInvokeTimeoutMs` — fallback timeout for contribution invocations that declare no `timeoutMs`
- `shellRunTimeoutMs` — default timeout for plugin `shell.run` commands when the plugin omits `timeoutMs`
- `taskRunWaitTimeoutMs` — maximum time a plugin `task.run` waits for a delegated task to reach a terminal state

Process-owned `pluginRuntimePolicy.limits` values — startup timeout, heartbeat interval, host-service request timeout, memory monitor limits, and shutdown grace — are applied to the plugin process runtime when it starts and require a runtime restart or reload to change. The five timeout keys above are invocation-level: they resolve in the invoking Scope on each plugin call (or hook trigger), so a `50-plugins.jsonc` change takes effect on the next call.

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

## Activity display

`activityDisplay` is a global General preference controlling how much agent activity detail the interface shows. It lives in `00-general.jsonc` and accepts three values:

```jsonc
{
  "activityDisplay": "balanced", // full | balanced | minimal
}
```

`balanced` is the default when the field is absent. Settings manages the preference globally in the installation config. If the key is declared manually in project config, ordinary project-over-global precedence still applies.

- `full` preserves the detailed turn timeline: every reasoning, text, tool, media, and attachment part stays in its original part order, matching pre-preference behavior. It never invokes the activity-summary nano model.
- `balanced` replaces raw reasoning with one root-turn status row rather than model-generated reasoning text. After reasoning begins, the working turn shows one stable `Thinking…` row across all assistant messages, or — when `compactReasoning` is enabled — one live single-line reasoning row. When the turn completes, that row disappears if the turn produced text, tool activity, or a receipt; an otherwise empty reasoning-only turn keeps one deterministic `Reasoning` fallback. With `compactReasoning` enabled, each settled assistant message instead keeps one collapsed expandable reasoning row anchored at its original part position, so the complete reasoning stays available. Reasoning never invokes the `nano` model or writes derived activity metadata.
  Settled ordinary tool tails (completed or error) are grouped by shared user-facing intent through one bounded `nano` call; stable semantic groups carry a concise summary, while deterministic fallback tail groups may omit text. Text, reasoning, attachment, receipt-tool, and message boundaries remain hard boundaries; in settled and persisted semantic membership, an error step stays in its current group, promotes that group to error, and prevents later steps from joining, while transient unpersisted streaming grouping uses deterministic family-and-scope adjacency until persisted signatures arrive. File and URL hints sent for semantic grouping are reduced to bounded non-sensitive forms such as a basename or origin; tool inputs, outputs, full paths, raw errors, and secrets are excluded. The model output must cover every step once, preserve order, and stay within the 24-step group limit. Invalid output, timeout, provider failure, or a manifest larger than 48 steps falls back for the whole unsettled tail. Tool-group nano summaries and semantic group signatures remain internal presentation metadata rather than visible parent rows. The group's original tool calls render as flat, independently expandable rows, may span different activity families, and keep their own family action labels, titles, states, results, and specialized content. Balanced mode does not render a group topic, progress marker, step count, connector, or parent indentation.
- `minimal` collapses each turn into one compact per-turn activity summary with animated count updates and, when available, one latest high-level tool-activity line. Raw reasoning and reasoning-status rows are not rendered. Permission, failure, external-action, and production communication receipts stay standalone, and other non-tool timeline items continue to render in their original position.

The mode changes only activity presentation. It never hides permission requests, failures, or external-action and production communication receipts, and it never rewrites message parts or changes model context. In `balanced` and `minimal`, bounded tool-group nano summaries and semantic group signatures may be persisted as derived assistant `metadata.activity` so reconnects and historical turns retain the same presentation. Historical `reasoning` entries and `now.source: "reasoning"` remain schema-valid read-only compatibility data but are not produced or used by the Balanced reasoning projection. Mode changes update already rendered turns reactively without remounting them.

## Compact reasoning

`compactReasoning` is a global General preference that keeps live reasoning output in a single-line view. It lives in `00-general.jsonc`:

```jsonc
{
  "compactReasoning": false,
}
```

`false` is the default when the field is absent. Settings → General manages the preference in the installation config. If the key is declared manually in project config, ordinary project-over-global precedence still applies.

While the assistant turn is streaming, the working turn shows only the latest reasoning block projected to one stable plain-text line: the most recent non-structural line of the reasoning markdown, skipping blank lines, code fences, and horizontal rules, and stripping markdown list, quote, and heading prefixes. When the turn settles, each assistant message keeps one collapsed expandable reasoning row anchored at its original part position, exposing the complete reasoning on expansion. Complete reasoning data is never modified — compact mode changes presentation only, and complete reasoning text remains available after the turn settles. In `balanced` activity display, the preference upgrades the `Thinking…` status row into the live one-line reasoning row while streaming; the status row remains when the preference is off. In `full` activity display the preference keeps only the latest reasoning block while streaming and restores the complete reasoning blocks once the turn settles. In both modes, a settled turn keeps one collapsed expandable reasoning row per assistant message instead of dropping the reasoning.

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
- `grok` uses xAI subscription OAuth device-code credentials (SuperGrok / X Premium+) and the OpenAI-compatible `https://api.x.ai/v1` API. The Grok model list is discovered live from the xAI `/v1/language-models` API with the stored subscription OAuth credential and refreshes automatically (≤1h TTL, or via `synergy models --refresh`); offline or failed discovery falls back to the bundled list.

Do not copy credentials or billing assumptions between them. Use `synergy auth` or the Settings UI to manage auth.

### Live provider model discovery

Providers that support live model discovery use one versioned `ProviderCatalog` snapshot per opaque account-identity hash. Snapshots are stored atomically under `cache/`, never contain credentials or raw account identifiers, and retain at most 100 provider/identity entries while protecting the current identity from eviction.

Startup reads the snapshot immediately and refreshes it asynchronously. A successful non-empty response becomes the active catalog; models missing from that response are retained only so existing sessions can continue to resolve their selected model. New sessions, defaults, role selectors, recommendations, and quick switching use active, non-deprecated models only. A timeout, network error, rate limit, upstream error, empty response, or corrupt cache never replaces the last verified model set.

Authentication, account usage, and model-catalog health are independent states. `POST /provider/{providerID}/models/refresh` runs the same single-flight refresh path used by background discovery. Missing models and explicit upstream model rejection produce `ProviderModelUnavailableError`; session execution does not silently switch to another model.

### Multiple account connections

A local provider connection can reuse a canonical Models.dev catalog while keeping a distinct provider ID and credentials:

```jsonc
{
  "provider": {
    "deepseek-team": {
      "modelsDevProviderID": "deepseek",
      "name": "DeepSeek Team",
      "env": ["DEEPSEEK_TEAM_API_KEY"],
    },
  },
}
```

Inherited models are projected onto the connection ID, so model references such as `deepseek-team/deepseek-chat` select that account. Connection-level `api`, `npm`, `options`, allowlist/blacklist, and explicit model entries override inherited catalog metadata without mutating the canonical provider.

`modelsDevProviderID` shares model metadata only. Set `profile` separately when the connection should also use the canonical provider's runtime hooks, model factory, auth recovery, usage reporting, and credential-aware live discovery. Credentials, health, live catalog snapshots, and model references remain keyed by the connection ID.

Removing a named connection is rejected with `ProviderConnectionInUseError` while any model role, agent, command, category, Quick Switcher entry, or Feishu/Lark account still names that connection. The error includes the referencing configuration paths; clear or replace those selections before retrying removal.

Keeping these fields separate is intentional: an OpenAI-compatible gateway can inherit a catalog without inheriting the canonical provider's OAuth or request behavior.

### Model variants and role variants

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility, so custom provider aliases retain correct behavior.

`ProviderTransform.variants()` applies transport-specific rules for third-party services on Anthropic and OpenAI-compatible wiring. Kimi K3 models on direct Anthropic transport expose catalog-declared `low`, `high`, and `max` variants. `low` and `high` map to Anthropic `effort`; `max` omits `effort` because Kimi's service default is already `max` and the locked Anthropic SDK accepts only `low`, `medium`, or `high`. Selecting no variant likewise uses Kimi's server-side `max` default. Kimi K2.x models remain provider-managed and receive no automatic Anthropic thinking variants. MiniMax M2.x models on direct Anthropic transport likewise produce no variants because reasoning is always on. MiniMax M3 on direct Anthropic transport exposes only a `max` variant mapped to `thinking: { type: "adaptive" }`; without it, reasoning defaults to off. MiniMax models on direct OpenAI-compatible Chat transport receive no `reasoningEffort` variants because that endpoint does not support `reasoning_effort`.

`role_variant` selects a variant name for a model role only when the resolved model exposes that same variant. If a provider-managed reasoning model exposes no automatic variants, `role_variant: { "thinking": "max" }` does not synthesize provider options; the request uses the provider's default reasoning behavior. Explicit model `variants` configured under a provider model are merged after automatic defaults, so they can add or override named variants for that model.

Feishu/Lark account configuration may pair an explicit `model` with `variant`. The Settings Channel model selector lists the same model variants used by model roles, and the selected variant is sent only while that account model is effective. A conversation-level `/model` override takes precedence and does not reuse the account model's variant.

A Feishu/Lark account may also set `projectDir` to bind the account's sessions to a project Scope. Resolution rules and error behavior are documented in the [Channels reference](../product/connections.md).

## Feishu/Lark Channel Settings

`90-channels.jsonc` owns the built-in Feishu/Lark Channel provider under `channel.feishu`. A minimal configuration is:

```jsonc
{
  "channel": {
    "feishu": {
      "type": "feishu",
      "domain": "feishu",
      "streaming": true,
      "accounts": {
        "default": {
          "appId": "cli_...",
          "appSecret": "...",
        },
      },
    },
  },
}
```

Provider-level fields apply as defaults to all accounts:

| Field            | Type                     | Default      | Behavior                                                                      |
| ---------------- | ------------------------ | ------------ | ----------------------------------------------------------------------------- |
| `type`           | `"feishu"`               | required     | Selects the built-in Feishu/Lark provider.                                    |
| `accounts`       | object                   | required     | Maps stable local account IDs to account configurations.                      |
| `domain`         | `"feishu"` or `"lark"`   | `"feishu"`   | Selects the China or international API domain unless an account overrides it. |
| `streaming`      | boolean                  | `true`       | Enables streaming cards unless an account overrides it.                       |
| `responseFormat` | `"text"` or `"markdown"` | `"markdown"` | Sets the ordinary outbound text format unless an account overrides it.        |

Each entry in `accounts` supports:

| Field                 | Type                                                                                      | Default                           | Behavior                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean                                                                                   | `true`                            | Enables connection startup for this account.                                                                                                                                                                                                                                                    |
| `appId`               | string                                                                                    | required                          | Feishu/Lark application ID.                                                                                                                                                                                                                                                                     |
| `appSecret`           | string                                                                                    | required                          | Feishu/Lark application secret. It is sensitive configuration and is redacted from normal config responses.                                                                                                                                                                                     |
| `domain`              | `"feishu"` or `"lark"`                                                                    | provider value                    | Overrides the provider API domain for this account.                                                                                                                                                                                                                                             |
| `allowDM`             | boolean                                                                                   | `true`                            | Accepts direct messages.                                                                                                                                                                                                                                                                        |
| `allowGroup`          | boolean                                                                                   | `true`                            | Accepts group messages.                                                                                                                                                                                                                                                                         |
| `requireMention`      | boolean                                                                                   | `true`                            | Requires a real mention of Synergy in group messages.                                                                                                                                                                                                                                           |
| `botOpenId`           | string                                                                                    | resolved automatically            | Supplies Synergy's bot `open_id` for mention and self-message validation; when omitted, the provider resolves it through the bot-info API and fails closed where that identity is required.                                                                                                     |
| `projectDir`          | string                                                                                    | home Scope                        | Binds every endpoint session for the account to the project Scope resolved from this directory. Relative paths resolve from the Synergy home directory. Invalid or non-project directories fail account startup.                                                                                |
| `streaming`           | boolean                                                                                   | provider value, then `true`       | Overrides streaming cards for this account. When disabled, the provider sends the terminal response through ordinary messages.                                                                                                                                                                  |
| `responseFormat`      | `"text"` or `"markdown"`                                                                  | provider value, then `"markdown"` | Overrides the ordinary outbound text format for this account. `"markdown"` delivers terminal answers as a CardKit markdown card so Feishu renders formatting, falling back to plain text when the card is too large or the card API fails.                                                      |
| `streamingThrottleMs` | positive integer                                                                          | `100`                             | Sets the minimum interval in milliseconds between streaming-card updates.                                                                                                                                                                                                                       |
| `groupSessionScope`   | `"group"`, `"group_sender"`, `"group_topic"`, `"group_topic_sender"`, or `"group_thread"` | `"group"`                         | Chooses whether group sessions are shared, isolated by sender, isolated by topic, isolated by topic and sender, or keyed one session per Feishu thread. `"group_thread"` uses `thread_id` as the only continuity key and falls back to one session per top-level message when no thread exists. |
| `inboundDebounceMs`   | non-negative integer                                                                      | `0`                               | Debounces rapid messages from the same sender in the same chat; `0` disables debouncing.                                                                                                                                                                                                        |
| `model`               | string                                                                                    | global model resolution           | Selects the account model in `providerID/modelID` form.                                                                                                                                                                                                                                         |
| `variant`             | string                                                                                    | model default                     | Selects an exposed variant while the account's `model` remains effective. A conversation `/model` override does not inherit it.                                                                                                                                                                 |
| `resolveSenderNames`  | boolean                                                                                   | `true`                            | Resolves sender display names through the Feishu contact API.                                                                                                                                                                                                                                   |
| `replyInThread`       | boolean                                                                                   | `false`                           | Sends replies into the Feishu topic/thread when a reply anchor is available.                                                                                                                                                                                                                    |

See [Connections](../product/connections.md) for endpoint reuse, group scope semantics, commands, response cards, outbound delivery, and callback validation.

## Control Profiles and Sandbox

`controlProfile` selects `guarded`, `autonomous`, or `full_access`. Session and agent settings can override the global value through the resolution order documented in [Execution Boundaries](../architecture/execution-boundaries.md).

`permission` adds capability/tool rules; `sandbox` selects backend behavior and fallback; `smartAllow` enables constrained high-confidence resolution of eligible decisions. A permissive permission rule does not make a hidden tool visible, and sandbox configuration does not replace the authorization decision.

## Server Settings

The `server` object supports `hostname`, `port`, `mdns`, and additional allowed origins through `cors`. Explicit CLI network flags override configured values. The managed background service snapshots these values into its service definition, so restart the service after changing them.

Each explicit `server.cors` entry authorizes both ordinary cross-origin HTTP requests and Browser viewer WebSocket handshakes from that exact HTTP(S) origin. Automatically detected LAN CORS origins and reverse-proxy forwarding headers do not authorize Browser viewer sockets; configure the public Browser viewer Origin explicitly.

`SYNERGY_ALLOWED_ORIGINS` is a comma-separated compatibility source for additional Browser viewer Origins. Its value is snapshotted when the server process starts, is read again after a restart, and does not add HTTP CORS response headers.

Binding a server beyond loopback exposes it to other hosts. Configure allowed origins and the surrounding network boundary deliberately.

## Code Checks

Post-write language-server diagnostic policy. Controls the diagnostics returned after write, edit, save_file, revise_file, and resolve_conflicts complete. All fields are owned by `120-runtime.jsonc`.

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

| Field                        | Required                    | Default                          | Description                                                                                                                                                                     |
| ---------------------------- | --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedding.local.source`     | no                          | `"huggingface"`                  | Download source: `"huggingface"` downloads from Hugging Face Hub, `"hf-mirror"` uses the HF Mirror (`https://hf-mirror.com/`), and `"custom"` uses a user-supplied `remoteHost` |
| `embedding.local.remoteHost` | when `source` is `"custom"` | —                                | Public HTTPS origin with no credentials, path, query, or hash. Local, private, and loopback hostnames are rejected; the field is ignored for built-in sources.                  |
| `embedding.local.cacheDir`   | no                          | ~/.synergy/data/embedding/models | Directory where the bundled local embedding model is cached; supports {env:VAR} references                                                                                      |

The model ID and quantization dtype are not configurable. The cache directory defaults to `~/.synergy/data/embedding/models` and can be redirected with `embedding.local.cacheDir`.

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

The configured value is the scheduler maximum. Memory pressure temporarily lowers new-task admission to four tasks, or two under critical pressure; running tasks are not cancelled. The scheduler uses the shared session memory classification, with earlier ArrayBuffer pressure thresholds at 1 GiB and 2 GiB. Settings and the Cortex concurrency status API report both the configured maximum and the effective pressure-capped limit. `SYNERGY_CORTEX_GLOBAL_CONCURRENCY` is a process-local positive-integer override with higher precedence than the global config value; while it is set, Settings reports the environment-managed maximum instead of editing it.

## Compaction

Compaction settings are owned by the Runtime domain (`120-runtime.jsonc`):

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": true,
    "overflowThreshold": 0.85,
    "maxHistoryImages": 8,
  },
}
```

| Field                          | Required | Default | Description                                                                                 |
| ------------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------- |
| `compaction.auto`              | no       | `true`  | Enable automatic compaction when the measured prompt crosses the soft budget                |
| `compaction.prune`             | no       | `true`  | Enable pruning of old tool outputs                                                          |
| `compaction.overflowThreshold` | no       | `0.85`  | Fraction of the input envelope that triggers auto-compaction; constrained to `0.5`–`1`      |
| `compaction.maxHistoryImages`  | no       | `8`     | Maximum historical images sent as base64 per request; older images become text placeholders |

The soft budget is `floor(inputEnvelope * overflowThreshold)`. The input envelope is the usable input for models with an explicit input limit, and `context - output - margin` for shared-context models only when reserving output and margin leaves a positive remainder; fully shared or near-window output declarations otherwise use the model's usable input. The margin is `min(32000, max(2048, ceil(context * 0.05)))`. See [LLM loop and compaction](../architecture/llm-loop.md#prompt-budget) for the full budgeting model. When automatic compaction is enabled, a prompt with no response space receives one root-scoped compaction attempt before Synergy stops locally with an actionable error; when automatic compaction is disabled, it stops immediately. An explicit per-request output limit remains effective when model context metadata is unavailable. `SYNERGY_DISABLE_AUTOCOMPACT=1` and `SYNERGY_DISABLE_PRUNE=1` force `auto` and `prune` off for the process.

## Runtime Boss Mode

Runtime Boss Mode is an experimental Runtime-domain feature: when enabled, the runtime auto-provisions a home-scope runtime boss session per enabled Feishu account and routes all accepted Feishu group and direct messages to it. All keys are optional, experimental, and live under `experimental` in `120-runtime.jsonc`:

```jsonc
{
  "experimental": {
    "boss_mode": true,
    "boss_identity_text": "...",
    "boss_briefing_interval_days": 7,
  },
}
```

| Key                                        | Type             | Default         | Behavior                                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `experimental.boss_mode`                   | boolean          | `false`         | Enables Runtime Boss Mode: auto-provisions one home-scope runtime boss session per enabled Feishu account and routes all accepted Feishu group and direct messages to it.                                                                              |
| `experimental.boss_identity_text`          | string           | default persona | Optional colleague-identity description injected into the runtime boss session briefing and per-turn `<boss-identity>` context; when omitted, a default colleague persona is used and the collaboration discipline block is still injected every turn. |
| `experimental.boss_briefing_interval_days` | positive integer | disabled        | Periodically delivers a refresh instruction to the runtime boss to re-enumerate sessions, projects, agenda, memory, and experience; omitted or non-positive disables periodic re-injection.                                                            |

Disabling `boss_mode` reverts Feishu routing to per-chat sessions; the boss session and its history remain. See [Workflows](../architecture/workflows.md) and [Connections](../product/connections.md) for routing and governance details.

## GitHub Channel

The GitHub Channel connects a GitHub App installation as a Channel (like Feishu or Clarus). Synergy polls configured repositories outbound using GitHub App installation tokens — no public inbound listener is required. Repository events are synthesized into conversation messages that run the agentic `github-channel-agent` inside a per-thread checkout, and results are posted back as GitHub comments.

Configuration lives in the Channels domain (`90-channels.jsonc`) under `channel.github`:

```jsonc
{
  "channel": {
    "github": {
      "type": "github",
      "accounts": {
        "default": {
          "enabled": true,
          "repositories": ["owner/repo"],
          "workspaceDir": "github-workspaces",
          "pollingIntervalMs": 300000,
          "autoReview": true,
          "autoRespond": true,
          "agent": "github-channel-agent",
        },
      },
    },
  },
}
```

### Account settings

| Field               | Required | Default                  | Description                                                                                                                                                       |
| ------------------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | no       | `true`                   | Master switch for the account; disabled accounts do not poll or create sessions                                                                                   |
| `repositories`      | yes      | —                        | `owner/repo` list to watch and respond to                                                                                                                         |
| `workspaceDir`      | yes      | —                        | Directory (relative to the Synergy data home) under which per-thread checkouts are created                                                                        |
| `workspaceTtlHours` | no       | `24`                     | Hours an unused per-thread checkout is kept before its local clone is removed; session history is preserved and the clone is recreated on the next thread trigger |
| `pollingIntervalMs` | no       | `300000` (5 min)         | Milliseconds between poll cycles per repository                                                                                                                   |
| `autoReview`        | no       | `true`                   | Automatically review newly opened and updated pull requests                                                                                                       |
| `autoRespond`       | no       | `true`                   | Respond to `@`-mentions of the bot handle and answer issue/PR questions; newly opened issues are diagnosed                                                        |
| `agent`             | no       | `"github-channel-agent"` | Agent used for GitHub channel sessions                                                                                                                            |
| `model` / `variant` | no       | —                        | Per-account model override (same shape as Feishu accounts)                                                                                                        |

### GitHub App credentials

The channel uses GitHub App authentication for all REST API calls and git operations. These credentials are env-only and never appear in config:

- `SYNERGY_GITHUB_APP_ID` — the GitHub App ID used to sign installation-access JWTs
- `SYNERGY_GITHUB_APP_PRIVATE_KEY` — the RSA private key for the GitHub App; `\n` sequences in an environment variable are automatically converted to literal newlines

Polling requires these credentials. There is no webhook secret, no inbound webhook route, and no CORS bypass for GitHub.

See [GitHub Channel](../architecture/github-channel.md) for the polling architecture, event gating, per-thread checkout management, and agent contract.

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

## Damaged Config Isolation and Recovery

Configuration files are validated as they are loaded. A file with a JSON(C) syntax error, a root-level type error, or a top-level key that belongs to another domain is moved aside instead of blocking startup or interrupting a running server:

- The offending file is renamed to `<filename>.invalid-<timestamp>-<random>` next to the original.
- The affected domain is skipped; the rest of the configuration loads normally, and the server keeps running.
- The event is recorded in the diagnostics registry and surfaced in the startup banner, the Web Settings panel banner, and `GET /config/diagnostics` (SDK: `client.config.diagnostics()`).
- Section-level schema errors keep the existing behavior: the invalid section is stripped and defaults are used; the file is not moved.

Quarantine uses a non-blocking domain lock: when a configuration write transaction (for example a Settings save) is already in flight for the same domain, the broken file is _not_ moved aside — the transaction's own write replaces it with a valid configuration, which is equivalent to recovery. The issue is still recorded in the diagnostics registry. Reload and startup paths, which hold no transaction lock, always quarantine as described above.

To recover a quarantined file, fix the content and rename it back to its original name (for example `110-email.jsonc.invalid-…` → `110-email.jsonc`). The file watcher picks the change up and reloads the domain. Quarantined files are never deleted automatically.

The legacy global config file (`synergy.jsonc`/`synergy.json`) is handled the same way: a broken legacy file is quarantined and the domain fragment migration is skipped. A malformed remote well-known config is skipped with a warning. Explicit CLI inputs (`SYNERGY_CONFIG_CONTENT`) still fail loudly because they are intentional process-level overrides.

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

| Variable                                      | Effect                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNERGY_ARXIV_API_URL`                       | Replace the built-in arXiv search service base URL                                                                                                                          |
| `SYNERGY_SEARXNG_URL`                         | Replace the built-in Web search service base URL                                                                                                                            |
| `SYNERGY_DISABLE_MODELS_FETCH=true` or `1`    | Disable ModelsDev catalog fetches performed by the source macro and runtime refresh; runtime disk cache and the bundled snapshot remain active                              |
| `MODELS_DEV_API_JSON`                         | Override the models catalog source embedded by the build-time Bun macro; local builds may set this, while the release workflow always forces the repository-pinned snapshot |
| `SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH=true` | Use the last verified provider catalog cache instead of fetching its signed remote source                                                                                   |
| `SYNERGY_DISABLE_LSP_DOWNLOAD=1`              | Prevent automatic language-server downloads                                                                                                                                 |

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

| Variable                             | Effect                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNERGY_ALLOW_REAL_HOME=1`          | Opt out of the test-home guard (`TestHomeGuardError`) for a deliberate real-home or non-isolated test run                                                |
| `SYNERGY_TEST_HOME`                  | Isolated home for test processes (positive marker required by the test-home guard; set by `test:ci`/`test:coverage` orchestrators and `test/preload.ts`) |
| `SYNERGY_TEST_ROOT`                  | Isolated fixture root for test processes (set by the orchestrators and `test/preload.ts`)                                                                |
| `SYNERGY_EXPERIMENTAL=1`             | Enable the grouped experimental behaviors that explicitly consult it                                                                                     |
| `SYNERGY_EXPERIMENTAL_OXFMT=1`       | Allow the experimental `oxfmt` formatter path                                                                                                            |
| `SYNERGY_EXPERIMENTAL_LSP_TY=1`      | Prefer the experimental `ty` Python language server over Pyright                                                                                         |
| `SYNERGY_EXPERIMENTAL_LSP_TOOL=1`    | Register the experimental direct LSP tool                                                                                                                |
| `SYNERGY_DISABLE_MESSAGE_CACHE=1`    | Bypass the loop-scoped model-working-set cache and reconstruct it from storage on every read                                                             |
| `SYNERGY_VERIFY_MESSAGE_CACHE=1`     | Compare the cached model working set with storage and fall back when they diverge                                                                        |
| `SYNERGY_SESSION_CACHE_MAX_BYTES`    | Set the aggregate and per-session model-working-set cache byte budget; defaults to 256 MiB                                                               |
| `SYNERGY_DISABLE_LSP_REAP=1`         | Keep idle LSP clients instead of reaping and recreating them on demand                                                                                   |
| `SYNERGY_LSP_MAX_CLIENTS_PER_SERVER` | Set the per-language-server client cap; the minimum is one and the default is two                                                                        |

Experimental and diagnostic variables are not persisted preferences. Use them to isolate behavior, then fix or configure the owning subsystem instead of relying on them as permanent compatibility layers. Performance-specific environment variables are listed in [Performance Observability](../operations/performance-observability.md); Desktop build/release variables are listed in [Desktop Release](../operations/desktop-release.md).
