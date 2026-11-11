# @ericsanchezok/synergy-app

The web client for [Synergy](https://github.com/SII-Holos/synergy) — a browser-based interface for working with sessions, agents, configuration, notes, memory, and community features. Built with SolidJS and Vite.

## Development

Personal space connects to a running Synergy Runtime. Organization spaces connect independently to their organization service; their execution and sharing model is documented in [Organization architecture](../../docs/architecture/organization.md). From the monorepo root:

```bash
# Start the server plus Vite web client
bun dev web

# Or start only this Vite app against an existing server
bun dev app --open
```

Vite handles hot module replacement, so changes appear in the browser immediately.

Private organization tool files open through finite metadata pages and share the transcript's verified preview and streaming save actions. They use the captured Session reader; an empty visible page may still have another page. See [organization file transfers](../../docs/decisions/implemented/architecture/2026-11-11-bound-organization-desktop-file-transfers.md).

Frontend colors and selectable themes follow the repository's [semantic theme contract](../../docs/reference/frontend-theming.md). Product components must consume canonical tokens rather than Tailwind palette colors, literal colors, or component-local theme maps.

## Build

```bash
bun run build
```

Produces static files in `dist/`, ready to be served by the Synergy server or any static host.

## Monorepo context

This package is part of the Synergy monorepo and depends on several sibling packages (`synergy-sdk`, `synergy-ui`, `synergy-util`). It is not designed to be used standalone.

See the [main repository](https://github.com/SII-Holos/synergy) for setup instructions and project documentation.

## License

MIT
