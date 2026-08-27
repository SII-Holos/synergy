# Decision Record: Config export command and API

Status: implemented

## Problem

Configuration import (`synergy config import`, Settings Import UI) had no export counterpart: users could not snapshot or move their configuration between machines or scopes. Read APIs (`config.get`, `config.global`, `config.domain.get`) return scope-merged, client-shaped config, not an import-ready payload, and there was no way to produce one without hand-merging domain files.

## Decision

- **`ConfigExport` namespace** (`packages/synergy/src/config/export.ts`) builds an export from the domain registry: `build({scope, only, includeSecrets?})` reads each selected domain's own file at the target scope (global or the active project), merges keys in registry order, and emits a `ConfigExportResult` (`{scope, scopeID, secretsIncluded, domains, config}`). Only domains with configuration are included. The export carries **no `$schema`** — the only schema URL the runtime knows is the install-local `file://` path (`Global.Path.configSchemaUrl`), a broken link on any other machine, and the import side ignores `$schema` — so the output stays machine-independent.
- **Secrets are redacted by default** through the existing `Config.redactForClient()`, so the default export carries the `__REDACTED__` sentinel in place of provider `apiKey`s, email passwords, Feishu `appSecret`s, embedding/rerank keys, and MCP OAuth `clientSecret`s. `includeSecrets` keeps plaintext values. A redacted export is a valid import payload: `ConfigImport.plan`/`apply` already merge the sentinel back with stored secrets on the target, verified by a round-trip test.
- **CLI `synergy config export`** (`packages/synergy/src/cli/cmd/config.ts`): `--include-secrets` (default false), `--only <domain>` (repeatable), `--scope global|project` (default `global`), `--output`/`-o` (default stdout). Files written with `--include-secrets` are chmod'd to `0600` and the command prints a plaintext-secrets warning to stderr; file/stdout writes without secrets go to stdout so the output can be piped.
- **Route `GET /config/export`** (`config.export`, `packages/synergy/src/server/config-route.ts`) returns the same `ConfigExportResult` for the Settings UI and SDK (`client.config.export()`). Its query schema deliberately has **no `meta({ref})`**: a ref'd query object is registered by hono-openapi as a single-parameter component that keeps only its first property, which silently dropped `only` and `includeSecrets` from the generated SDK (pre-existing behavior; `PerformanceSummaryQuery` loses fields the same way). `includeSecrets` uses `z.stringbool({truthy:["true"], falsy:["false"]})` rather than `z.coerce.boolean()` because coercion maps the string `"false"` to `true` — a false positive here would leak secrets.
- **CLI reference generator fix** (`script/gen/gen-cli-reference.ts`): the top-level command table now resolves each command's description from the command blocks of its own module. A single global name-keyed map is ambiguous once a top-level command and a nested subcommand share a block name (`export` for sessions vs `config export`) — the last module visited won, and the table mislabeled `synergy export`. The `config` and `doctor` rows now also match `synergy <command> --help` (they previously echoed the first-seen duplicate block from another module). Detail sections keep the merged view.

## Alternatives considered

- **Export the merged runtime config** (`Config.current()` / `Config.globalRaw()`) — Rejected for moving config between machines: it contains env-expanded values and resolved defaults that domain files only state implicitly. Reading each domain file emits exactly what the user configured, which is what import expects to merge.
- **Separate `synergy config export --redact` flag** — Redaction is the safe default for anything written to disk or shared; opting into plaintext (`--include-secrets`) keeps the dangerous direction explicit rather than the safe direction.
- **Keep the `meta({ref})` and accept a partial SDK surface** — Dropping `only`/`includeSecrets` from the SDK would make the route unusable from the Settings UI; an inline query schema documents all three parameters in `openapi.json`.
- **Scanner-generated key patch for the CLI table only** — Leaves the same duplicate-name ambiguity for future commands; resolving descriptions per module removes the class of bug.

## Consequences

- New user surface: `synergy config export [--include-secrets] [--only <domain>...] [--scope ...] [--output file]`; SDK gains `client.config.export({scope, only, includeSecrets})`; `openapi.json` gains `/config/export`.
- A redacted export re-imported on the _same_ machine is a no-op for secrets (sentinel merges back with the stored value); on a _different_ machine the sentinel stays in the file until the user replaces it — imports with placeholder secrets will not silently carry working credentials across machines. `--include-secrets` is the explicit tool for full migration.
- Plaintext exports are `0600` but travel as ordinary files afterward; the warning states this in the terminal, and both guides mark the output as sensitive.
- The export reads are per-domain-file, so a quarantined broken domain reports as empty (import-shaped) rather than failing the whole export — consistent with `domainGet` behavior elsewhere.
- `docs/reference/cli.md` table descriptions for `config` and `doctor` changed to match runtime help output.
