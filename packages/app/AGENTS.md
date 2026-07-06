## Debugging

- To test the Synergy app, use the playwright MCP server, the app is already
  running at http://localhost:3000
- NEVER try to restart the app, or the server process, EVER.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Data sync

Frontend data loading and event handling follow `docs/frontend-sync-redesign.md`. Read it before changing `src/context/{global-sync,sync,local,layout}.tsx` or `pages/session.tsx`.

- Apply store updates with `reconcile` (or targeted `setStore(path, index, reconcile(value))`), never a whole-object replace — a whole-object replace gives the row a new identity and re-runs the entire reactive chain (the #319 flash).
- Read entities by key (`sync.session.get(id)`), not by scanning an array with `find`/`Binary.search`, so a memo only subscribes to the entity it reads.
- Composer model/agent come from `composer-intent.ts` layers (draft → sessionDefault → fallback); never write a derived or historical value back into the user's draft (the #318 overwrite).
- State events carry `seq`/`epoch`; the per-scope watermark and reconnect replay live in `global-sync.tsx`. Don't add per-event REST refetches — the event stream is authoritative between snapshots.

## Settings

- Use `packages/app/src/components/settings/catalog.ts` as the source of truth for built-in settings sections, groups, metadata, domains, search keywords, and save strategy.
- Derive config field ownership from `/config/domains` summaries, especially `ownedKeys`. Do not add duplicate frontend field-to-domain maps.
- Do not build JSON editors for canonical config domains. Common settings should use focused forms; complex or low-frequency config should show the canonical file path and use the generated `config.domain.open` SDK method.
- Preserve plugin-contributed settings sections. Built-in sections should use `iconToken`; plugin sections may continue to use plugin-provided icons.
- Settings UI labels must be English-only and should avoid paired `X & Y` titles.

## Product Design

- Treat `packages/app/PRODUCT.md` as the durable Web product contract. Read it before frontend work that changes interaction structure, visual hierarchy, theme behavior, or product taste.
- When a product design decision becomes a reusable principle, update `packages/app/PRODUCT.md` in the same task so future changes inherit it.
- Keep light and dark mode surface polarity aligned with PRODUCT.md: in dark mode, content and selected surfaces step brighter than their containers; in light mode, content and selected surfaces step darker than their containers.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
