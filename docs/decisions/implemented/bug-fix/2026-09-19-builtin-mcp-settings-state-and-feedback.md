# Decision Record: Repair built-in MCP settings state, status copy, and key feedback

Status: implemented

## Problem

Three defects met on the Settings → MCP panel for the built-in `anysearch`/`scholight` servers, and together they produced the impression that the panel was broken.

**Phantom unsaved state.** `buildMcpPatch` in `apps/web/src/components/settings/hooks/useConfigPatch.ts` hoisted type-less stubs (the `{ apiKey | enabled }` markers that never take ownership of a built-in name) to the front of the rebuilt `mcp` map, then added typed user servers, then the built-in toggles/keys. It decided whether to emit a patch with an order-sensitive textual comparison:

```ts
if (JSON.stringify(newMcp) !== JSON.stringify(cfg.mcp ?? {})) patch.mcp = newMcp
```

The stored domain file keeps its own insertion order, and the write path (`mergeDeep` in `packages/harness/src/config/config.ts`, then `sortConfigKeys`, which orders only top-level domain keys) never reorders keys inside `mcp`. Record schemas (`z.record`) also preserve input order, unlike `z.object`. So once a config had at least one typed server **and** at least one built-in stub, the builder's order could never equal the stored order: the content was identical but the comparison said "changed". The panel therefore reported `未保存`/`Unsaved` after every successful save, closing Settings always raised the discard confirm, and each save re-wrote the `mcp` domain and triggered an MCP reload. Pasting a key was merely how a user entered that state — the key itself was never the cause.

**Contradictory status copy.** The switch was seeded from a connection string — `toggle: info.status.status !== "disabled"` — while the label mapped only two of the eleven `MCP.Status` members and collapsed the rest:

```tsx
connected ? Connected : disabled ? Off : Unavailable
```

Nine statuses (`uninitialized`, `starting`, `connecting`, `listing_tools`, `reconnecting`, `stopping`, `failed`, `needs_auth`, `needs_client_registration`) therefore rendered "switch on + Unavailable" by construction. Two aggravating factors: a complete, already-translated mapping existed but was used only by the MCP dialog, so the same status read differently in two surfaces; and the panel's built-in resource was fetched once and never refreshed, so a server that connected after the panel opened could read as not-yet-connected indefinitely.

**Weak key feedback.** A saved key was nearly invisible. Config read-backs redact the key to `REDACTED_SENTINEL`, so the client had only `keyConfigured: boolean` and no way to show which key was stored; the save path reset the draft to `""`, making "configured" and "never configured" look identical in the field; and the configured placeholder read "Key set — paste a key to raise rate limits", which argued against itself. The one visible difference — a faint text prefix plus a ghost icon — was contradicted by the section's own promise that the servers work without a key.

## Decision

**Compare MCP patches structurally.** `buildMcpPatch` now decides with `isDeepEqual` from `remeda` (already a dependency, and already the codebase's deep-equality idiom) instead of `JSON.stringify`. The emitted key order was deliberately left alone: order is not part of the stored semantics, and reordering the builder to chase the file's order would couple it to a writer-side detail that `mergeDeep` may legitimately change, whereas a structural comparison converges under any writer ordering.

**Give one presentation helper sole authority over MCP status.** `apps/web/src/components/mcp/status-presentation.ts` exports `mcpStatusCopy(status, _)` and `mcpStatusError(status)`, extracted from the dialog's existing complete mapping and now consumed by both the dialog and the settings panel, so the two can no longer disagree. It maps every `MCP.Status` member to a label, description, and tone (`connected` → success; `starting`/`connecting`/`listing_tools`/`reconnecting`/`stopping` → progress; `needs_auth`/`needs_client_registration` → warning; `failed` → danger; `disabled` and `uninitialized` → neutral), and reuses the already-translated `app.dialog.mcp.status.*` messages rather than adding parallel copy.

On top of that helper:

- The built-in switch is seeded from configuration intent via `builtinServerEnabled(cfg, name)`, not from a live connection string, so the switch reports what is saved and never flips while a server reconnects.
- The header line renders the real status with its tone, and failure/auth states additionally show their `error` text.
- Custom server cards receive the same live status, because they carried the same "switched on but not connected" blind spot behind their `Enabled`/`Paused` label.
- `SettingsPanel` fetches `mcp.status()` into a resource and refetches on any `mcp.*` event, so status stays live while the panel is open.

**Make a stored key visible.** `builtinApiKeyHint(entry)` in `packages/agent-integrations/src/mcp/builtin-catalog.ts` returns a four-dot mask plus the stored key's last four characters, a bare mask for keys of eight characters or fewer, and `undefined` when no key is stored (reusing `builtinApiKeyOf`, so the empty-string clear marker still reads as absent). `MCP.builtins()` and the `/mcp/builtins` route schema expose it as an optional `keyHint`. The panel shows a three-state chip — `No key set`, `Key saved ••••1234`, `Not saved yet` (plus a clear-pending state) — and the configured placeholder now reads as a replacement prompt. Masking is computed server-side because the client only ever sees the sentinel.

`keyHint` is a deliberate, bounded disclosure of a live credential fragment and is documented as such in the `synergy-config` skill's MCP reference; it travels only through this field, is never logged, and is never reconstructed client-side.

## Alternatives considered

- **Reorder the emitted `newMcp` object to match the stored file order** — rejected: it depends on the writer forever preserving on-disk insertion order, and any later normalization would silently reintroduce the phantom-dirty state. The measured failure also showed the content was already identical, so ordering was never part of the intended semantics.
- **Canonically sort `mcp` keys on load and/or before comparing** — rejected: it would rewrite the user's config file layout as a side effect of opening Settings and churn unrelated diffs in `40-mcp.jsonc`.
- **Keep the textual comparison and special-case `mcp`** — rejected: same outcome as the chosen fix with an extra branch, and it leaves the same latent trap for any future record-shaped config field.
- **Send only changed MCP sub-entries instead of the full rebuilt map** — rejected: the stub and opt-out markers rely on full-map carry-forward, so this changes merge semantics for the whole domain — a far larger blast radius than the defect.
- **Split the enable switch and connection status into two separate visual elements** — rejected by explicit product decision: the header keeps a single status line so the card stays compact, and the contradiction is removed by correcting the copy rather than by adding an element.
- **Fix only the built-in cards and leave custom cards on `Enabled`/`Paused`** — rejected by explicit product decision: custom cards carry the same blind spot, and a shared status source makes both consistent for no extra mechanism.
- **Translate the nine collapsed statuses into a short list of new panel-specific strings** — rejected: it would create a second mapping that can drift from the dialog's, which is exactly the two-surfaces-disagree defect being fixed.
- **Derive the key hint on the client from the redacted config** — rejected as impossible: client read-backs only ever contain `REDACTED_SENTINEL`.
- **Show the full stored key, or its first and last characters, so the user can be certain** — rejected: unnecessary disclosure; tail-4 confirms "the key I pasted is stored" and matches the existing CLI precedent.
- **Gate `/mcp/builtins` behind `requireLocalhost` now that it returns a secret fragment** — rejected: the route already discloses `keyConfigured` to the same client, and `isLoopbackOrigin` demands an `http(s)://localhost` origin, which risks breaking desktop/webview origins for a four-character addition. The disclosure is documented as a bounded exception instead.
- **Rely on the existing save toast as the key-saved signal** — rejected: it is generic, transient, and shared with every other settings domain; it does not answer "is this server's key stored" when the user returns to the panel later.

## Consequences

- The panel's `未保存` badge and the discard-on-close confirm now reflect real edits only; a save with no content change emits no `mcp` patch at all, so it also stops re-writing the `mcp` domain and triggering a redundant MCP reload.
- Every MCP status renders its true state in both the dialog and the panel, and status changes reach an open settings panel. `uninitialized` reads as a neutral ready/not-connected state instead of `不可用`/`Unavailable`.
- The switch now expresses configuration intent, so a reconnecting or failing server no longer reads as if it were switched off, and switching a server off is no longer confounded with a transient connection state.
- A stored key is persistently visible with a masked tail; a typed-but-unsaved key is visibly distinct from a saved one, which is what the save path's draft reset previously erased.
- The structural comparison removes the false-positive direction of the bug while preserving the true-positive direction; the regression tests assert both, so a real toggle, key, or clear still emits its stub.
- Known, accepted cost: `/mcp/builtins` discloses four trailing characters of a stored key. Short keys (`<= 8` characters) fall back to a bare mask so the hint never reveals a large fraction of the secret.
- Adding `keyHint` changed a route schema, so the OpenAPI document and generated SDK types were regenerated rather than hand-edited.
