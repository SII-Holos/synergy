# Decision Record: Strip root-level unrecognized config keys instead of quarantining the file

Status: implemented

## Problem

Domain config files that still carried a retired top-level key — `20-providers.jsonc` with `providerCatalog`, removed from the schema and the providers domain's owned keys by [retire signed provider catalog](../architecture/2026-09-05-retire-signed-provider-catalog.md) — were renamed to `*.invalid-<ts>-<rand>` on load, discarding every valid provider connection in the file with it. The root `Config.Info` schema is strict, so a retired top-level key surfaces as a root-level zod issue with `path: []` and `keys: ["providerCatalog"]`. The partial-recovery path in `Config.load()` derived the section to strip from `String(issue.path[0])`, which is the string `"undefined"` for a root issue — it deleted a nonexistent `data["undefined"]`, the retry failed identically, and `loadDomainDirectory` quarantined the whole file. The one-shot cleanup migration cannot prevent this: it runs once per install, so a file restored from a backup after the migration ran (or written while a load raced migration completion) still carries the retired key. Parsing a quarantined file showed exactly one issue — the root `unrecognized_keys` — and removing that single key made the file fully valid.

## Decision

`Config.load()` partial recovery now treats a root-level `unrecognized_keys` issue as recoverable: it strips exactly `issue.keys` and re-validates through the existing strip-and-retry path with its "skipping invalid config sections" warning, instead of throwing `ConfigInvalidError`. Root-level `invalid_type` remains unrecoverable and still fails the load. Unknown top-level keys in any config file are therefore dropped with a warning at load time, matching the section-level recovery semantics that already applied to invalid sections with real paths. Strict parsing of config values (`Info.parse`) is unchanged — recovery happens only in the file-load layer.

## Alternatives considered

- **Re-running retired-key cleanup migrations on every config load** — rejected: it duplicates at load time what parsing can recover locally, would have to enumerate every future retired key forever, and still races a watcher-triggered load that reads the file before the sweep completes.
- **Quarantining with an actionable warning instead of stripping** — rejected as the primary behavior: it preserves data but leaves the user's providers unusable until manual intervention; stripping with a warning heals the file automatically, and the `.invalid-*` quarantine remains for genuinely unrecoverable files (syntax errors, root type errors).
- **Re-adding a tombstone `providerCatalog` key to the schema** — rejected: re-accepting retired keys restores the surface the retirement removed and does not generalize to the next retired key.

## Consequences

Files restored from backups or written around the cleanup migration now auto-heal on the next load instead of losing every custom provider in the file. The previous test contract that asserted an unknown top-level field fails the entire config load is replaced: unknown top-level keys are a load-time warning, not a hard error, so a typo in a key is now silently dropped rather than surfacing as a startup failure — the warning log is the only signal, and the strict schema contract is still asserted through direct `Info.parse`. Future schema key removals no longer require a matching cleanup migration to be load-safe, though migrations remain the right tool when a legacy value must be rewritten rather than dropped.
