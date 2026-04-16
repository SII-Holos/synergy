# Synergy

The core runtime for [Synergy](https://github.com/SII-Holos/synergy) — an AI agent platform built by the Holos team.

## What's in this package

This is the engine behind Synergy. It provides:

- **Server runtime** — a stateless server that clients connect to over HTTP
- **CLI** — `synergy start`, `synergy web`, `synergy send`, and operational commands for sessions, config, identity, and more
- **Agent system** — built-in configurable agents for coding, research, writing, orchestration, and review
- **Sessions** — persistent conversation management with recall and context
- **Tools** — file operations, search, process management, web access, and extensible tool definitions
- **MCP integration** — connect external tool ecosystems via the Model Context Protocol
- **Provider support** — multi-provider LLM integration (OpenAI, Anthropic, Google, and many others)
- **Config system** — layered configuration with global, project, and runtime scopes
- **Engram** — long-term memory and knowledge infrastructure
- **Notes, Agenda, Channels** — persistent notes, scheduled automation, and messaging integrations

## Installation

```bash
npm install @ericsanchezok/synergy
# or
bun add @ericsanchezok/synergy
```

## Quick start

Start the background service:

```bash
synergy start
```

Then open the web interface or send a one-off message:

```bash
synergy web
synergy send "summarize this project"
```

Check on the service at any time:

```bash
synergy status
synergy logs
```

## Documentation

For full setup instructions, configuration, development workflow, and the complete package map, see the [main repository README](https://github.com/SII-Holos/synergy).

## License

MIT
