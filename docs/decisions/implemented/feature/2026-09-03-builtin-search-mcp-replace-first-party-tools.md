# Decision Record: Built-in anysearch/scholight MCP servers replace first-party web/arxiv search tools

Status: implemented

## Problem

The first-party `websearch`, `arxiv_search`, and `arxiv_download` tools duplicated capability that two maintained remote MCP servers already provide with richer results: anysearch (web/general/vertical search with batch and URL extraction) and scholight (arXiv + scholarly paper search). Keeping both first-party tools and the MCP servers means two code paths to secure, permission, prompt, test, and document for the same agent intent — and the first-party arxiv tools depended on environment flags and endpoints that drifted from the products they wrapped.

A second problem is presentation. MCP tool parts are folded into grouped activity-summary rows in the default display, which hides per-query structure the user should be able to re-inspect after a research turn. Any replacement needed to keep these search cards visible as individual cards.

## Decision

Retire the three first-party tools end-to-end and ship the two remote search servers as built-in MCP servers, enabled by default and usable without an API key.

- **Tool removal**: `websearch`, `arxiv_search`, and `arxiv_download` are deleted across `packages/synergy` (tool definitions, registry, taxonomy, permission defaults, session/enforcement wiring, timeout maps, capability maps, UI registrations, tests, generated OpenAPI/SDK/i18n output). `webfetch` and every other tool stay. Fallback patterns `/^arxiv/i` and `/^(web)?search/i` remain so local/MCP arxiv and search tools still classify.
- **Built-in MCP catalog**: `packages/synergy/src/mcp/builtin-catalog.ts` defines two remote servers — `anysearch` at `https://api.anysearch.com/mcp` and `scholight` at `https://scholight.sanchezcloud.net/api/mcp` — both `type: remote`, `oauth: false` (static-bearer/anonymous auth, no OAuth probe), `startup: eager`, keyless by default. The catalog validates against the plugin `McpServerConfig` schema at load so a schema drift fails loudly.
- **Injection and precedence**: `McpSupervisor.initFromConfig` stages built-in entries after user config entries with source `builtin`, mirroring plugin-staging precedence. A user entry with the same name shadows the builtin when it is a full typed server (override) or an explicit `{ "enabled": false }` stub (opt-out); a bare `{ "enabled": true }` stub without a type does not own the name. Settings/CLI continue to treat servers uniformly (`source: "builtin"` added to `MCP.Server`).
- **API key stubs**: A `{ "apiKey": "..." }` stub (schema: `enabled?` + `apiKey?` on the non-typed union arm) raises rate limits without taking ownership of the name — `collectBuiltinMcpServers` injects it as `Authorization: Bearer <key>` at staging, and an empty string clears it. `GET /mcp/builtins` reports `keyConfigured`; config read-backs redact the key through the `REDACTED_SENTINEL` round-trip like other secrets. The Settings panel exposes a password field + clear control on each built-in card, and the `synergy-config` MCP reference documents the stub so agents can configure keys conversationally.
- **Test isolation**: `SYNERGY_DISABLE_BUILTIN_MCP` disables the catalog; `packages/synergy/test/preload.ts` sets it so no test ever connects to external endpoints.
- **Agent prompts**: the six prompt files that named the deleted tools now name the exact MCP ids (`mcp__anysearch__search`/`batch_search`/`extract`/`get_sub_domains`, `mcp__scholight__search_papers`), with key-gated `mcp__scholight__extract_url` documented as unavailable until a key is configured and anonymous full-text fallbacks (`mcp__anysearch__extract`, `webfetch`) where "download the PDF" intent existed.
- **Fold exemption**: `packages/util/src/activity.ts` treats `mcp__anysearch__*` and `mcp__scholight__*` as presentation-boundary prefixes in `isActivityGroupableTool`, so both the Web activity timeline and the server-side activity summary keep these cards visible instead of folding them into summary rows.
- **Tool cards**: per-user-approved B+C card design in `packages/ui` — brand-tinted header plus result-summary strip and optional top-result rows (B), and per-query step rows with footer summary for `batch_search` (C).

## Alternatives considered

- **Seeding the user config file with `40-mcp.jsonc` entries on first boot** — rejected: writing user-owned config implicitly mutates user state, and upgrades/overrides become a migration problem (what if the user later edits or removes the entry, or wants the builtin back after an upgrade?). A code-owned catalog with runtime shadowing keeps the shipped default out of user files.
- **Reusing the plugin MCP staging path for builtins** — rejected: plugin declarations are staged by plugin lifecycle with a pluginId owner and are replaced on plugin updates; builtins are versioned with the product, not with any plugin, and need a distinct `source` so list/status UIs can label them.
- **Exempting from folding via per-tool display metadata** (`display.toolCard`) — rejected: that flag hides cards entirely (it is the `hidden` path) and would need server-side persistence of display metadata on every part; a prefix rule in the shared util classification covers both Web and server-side summary in one place.
- **Exempting all `mcp__*` tools from folding** — rejected: user-configured MCP servers may be noisy or high-volume; only the two built-in search families get the presentation boundary.
- **Keeping `arxiv_search`/`arxiv_download` as thin wrappers over scholight** — rejected: that preserves two maintenance surfaces and permission keys; the MCP server is the canonical implementation, and prompts/tests migrate instead.

## Consequences

- New and existing installs get working web and academic search on first run with no configuration and no key; users can add API keys later by editing the same server name in `40-mcp.jsonc` (typed entry overrides, `enabled: false` opts out).
- The permission surface shrinks: three first-party permission keys, two environment flags, and their capability/timeout entries are gone; `mcp_invoke` (permissioned through `"mcp__*": "allow"` for research subagents and default allow for primary agents) governs the replacement.
- Two outbound connections are attempted at MCP startup in non-test runtimes; connection failure is handled by the existing retry/failed state machinery and never blocks boot.
- Search tool cards stay individually visible in activity timelines, at the cost of slightly more vertical space than a folded summary row for these two families.
- The shipped default points at remote third-party endpoints; the disable env var and per-name opt-out give users and CI an escape hatch, and a future product decision can change the catalog (schema-validated) without touching user config.
