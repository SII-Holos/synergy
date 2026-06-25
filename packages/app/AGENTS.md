## Debugging

- To test the Synergy app, use the playwright MCP server, the app is already
  running at http://localhost:3000
- NEVER try to restart the app, or the server process, EVER.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Settings

- Use `packages/app/src/components/settings/catalog.ts` as the source of truth for built-in settings sections, groups, metadata, domains, search keywords, and save strategy.
- Derive config field ownership from `/config/domains` summaries, especially `ownedKeys`. Do not add duplicate frontend field-to-domain maps.
- Do not build JSON editors for canonical config domains. Common settings should use focused forms; complex or low-frequency config should show the canonical file path and use the generated `config.domain.open` SDK method.
- Preserve plugin-contributed settings sections. Built-in sections should use `iconToken`; plugin sections may continue to use plugin-provided icons.
- Settings UI labels must be English-only and should avoid paired `X & Y` titles.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
