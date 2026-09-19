# Decision Record: Domain writes preserve authored config references

Status: implemented

## Problem

Every canonical config domain write — a Settings save (`PATCH /config/domains/:domain`), a `synergy config` write, `Config.domainUpdate`, or config import — persisted the read-time-resolved document. Because `load()` substitutes `{env:VAR}`/`{file:path}` references before parsing, the reference text existed only in the raw file bytes; the write path never saw it. Any save therefore rewrote the fragment with resolved literals via `JSON.stringify`, silently materializing secrets users had deliberately kept out of the config file, dropping JSONC comments, rewriting untouched entries, and re-serializing even an empty patch. The import path both preserves comments and warns against hardcoded secrets, while the save path defeated exactly that guidance. Materialized secrets also landed with umask-default permissions (typically 0644), wider than the 0600 secret file a reference may point at (SII-Holos/synergy#1415).

## Decision

Domain write paths now edit the raw fragment instead of persisting the resolved document. A shared renderer (`fragment-render.ts`) parses the on-disk JSONC, echo-normalizes the merged document, applies minimal leaf-level edits with `jsonc-parser`'s `modify`/`applyEdits`, and verifies the rendered text parses back to the merged document.

- `{env:}`/`{file:}` reference text stays a reference; comments and untouched entries survive byte-identical. Substitution remains read-time only.
- A patch value that merely echoes a raw reference's resolved value — redacted Settings round-trips restoring `__REDACTED__` sentinels, and read-modify-write helpers such as `domainMutateWithChange` whose callback returns the loaded value — restores the reference text. A genuinely new value replaces the reference with the literal. This makes `mergeRedactedSecrets` and the per-domain restore hooks work unchanged: the sentinel-restored literal matches the reference's resolution, so the renderer keeps the reference.
- A save whose merged document the fragment already represents skips the write entirely, so an empty save does not churn the mtime or wake the file watcher.
- Config import reuses the same renderer, gaining leaf-granularity preservation (the previous import renderer edited whole top-level keys) while keeping its refuse-on-malformed contract.
- Domain fragments are written user-only (`0600`), and an existing fragment's permissions are tightened on every save, since fragments can hold secret material.
- A malformed fragment cannot be edited in place. Domain writes keep today's recovery contract and replace it with the valid merged config; config import keeps refusing. A pathological fragment where targeted edits cannot represent the merged document (for example duplicate keys) falls back to canonical JSON of the echo-normalized document, so references still never materialize.
- Legacy migration writes keep `serializeConfig` canonical output; they run once on files that are about to be archived and their inputs are resolved documents by definition.

## Alternatives considered

**Track an unresolved merge representation alongside the resolved one.** Doubles the state every reader and writer reasons about for no behavioral gain over raw-text editing; the raw fragment already is the unresolved representation, and the redacted round-trip works against it via echo detection.

**Keep current behavior and document save-side materialization as a caveat.** Rejected: materializing secrets on save directly contradicts the configuration guidance to keep credentials in `{env:}`/`{file:}` references, and no documentation makes a 0600 secret file become plaintext in a world-readable fragment acceptable.

**Fix only the serializer to a comment-preserving pretty-printer.** Re-serializing the whole document still needs the reference text, which only exists in the raw bytes; preserving comments while materializing secrets would leave the core defect in place.

## Consequences

Saves are safe against the exact data-loss shape reported in #1415: secrets stay indirected, comments and unrelated entries survive, no-op saves stop rewriting files, and fragments are user-only. The fix is forward-only — literals already materialized by past saves remain on disk until the user re-adds references. Export still resolves references into its payload by definition, so cross-machine restores of `--include-secrets` backups still write literals where the reference cannot resolve; same-machine re-imports now restore the reference text. A save to a malformed fragment still silently replaces it (existing quarantine-equivalent recovery) rather than surfacing an error — a deliberate continuity choice import does not share. Tests and tooling asserting canonical sorted-JSON output on domain files now see raw-preserving output instead; the affected suites were updated in the same change.
