# @ericsanchezok/synergy-app

The web client for [Synergy](https://github.com/SII-Holos/synergy) — a browser-based interface for working with sessions, agents, configuration, notes, memory, and community features. Built with SolidJS and Vite.

## Development

The web client connects to a running Synergy server. From the monorepo root:

```bash
# Start the server first
bun dev

# Then connect to the server-served Web UI
bun dev web
```

Use `bun dev web --dev` only when actively debugging Vite/HMR behavior. Do not leave the Vite dev server running by default; the server-served Web UI is the normal path.

Vite handles hot module replacement when the dev server is intentionally started.

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
