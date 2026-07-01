# Synergy Plugin Docs

These docs describe the plugin platform and SDK contracts.

Start here:

- [agent-quickstart.md](agent-quickstart.md) — shortest path for external agents and plugin authors
- [development-kit.md](development-kit.md) — CLI, SDK, templates, and source-checkout boundary
- [01-platform-overview.md](01-platform-overview.md)
- [02-manifest-reference.md](02-manifest-reference.md)
- [03-trust-tiers.md](03-trust-tiers.md)
- [04-tool-renderer-guide.md](04-tool-renderer-guide.md)
- [05-workbench-panels.md](05-workbench-panels.md)
- [06-settings-themes-icons.md](06-settings-themes-icons.md)
- [07-sandbox-guide.md](07-sandbox-guide.md)
- [09-security-best-practices.md](09-security-best-practices.md)
- [developer-guide.md](developer-guide.md)

Canonical workflow:

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin
cd my-plugin
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
```

Public marketplace publishing uses the GitHub aggregator repository:

```bash
synergy-plugin publish-market --repo https://github.com/owner/my-plugin
```

Plugin authors do not need to read the repository root `AGENTS.md` unless they are modifying Synergy itself.
