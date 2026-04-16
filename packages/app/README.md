# @ericsanchezok/synergy-app

The web client for [Synergy](https://github.com/SII-Holos/synergy) — a browser-based interface for working with sessions, agents, configuration, notes, memory, and community features. Built with SolidJS and Vite.

## Development

The web client connects to a running Synergy server. From the monorepo root:

```bash
# Start the server first
bun dev

# Then, in another terminal, start the web client in dev mode
bun dev web --dev
```

Vite handles hot module replacement, so changes appear in the browser immediately.

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
