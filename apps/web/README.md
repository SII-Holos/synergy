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

Vite handles hot module replacement, so changes appear in the browser immediately. Organization connection recovery keeps revision-bound logout metadata across reload without retaining credentials; see [logout recovery](../../docs/decisions/implemented/bug-fix/2026-11-12-recover-native-logout-before-renderer-reload.md).

Private organization tool files open through finite metadata pages and share the transcript's verified preview and streaming save actions. They use the captured Session reader; an empty visible page may still have another page. See [organization file transfers](../../docs/decisions/implemented/architecture/2026-11-11-bound-organization-desktop-file-transfers.md).

Background completion and error notifications keep their original personal Runtime or organization account while another space is open. Their shared App surface opens that source only after checking its current identity; reconnect does not replay missed organization notices. See [notification presentation ownership](../../docs/decisions/implemented/architecture/2026-11-12-retain-notification-presentation-outside-space-views.md).

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
