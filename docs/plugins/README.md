# Synergy Plugin Docs

These docs describe the current plugin platform. Older v2/v3/v4 migration notes have been removed from this tree; trust the current implementation and SDK contracts.

Start here:

- [01-platform-overview.md](01-platform-overview.md)
- [02-manifest-reference.md](02-manifest-reference.md)
- [03-trust-tiers.md](03-trust-tiers.md)
- [04-tool-renderer-guide.md](04-tool-renderer-guide.md)
- [05-workspace-panels.md](05-workspace-panels.md)
- [06-settings-themes-icons.md](06-settings-themes-icons.md)
- [07-sandbox-guide.md](07-sandbox-guide.md)
- [09-security-best-practices.md](09-security-best-practices.md)
- [developer-guide.md](developer-guide.md)

Canonical workflow:

```bash
synergy plugin create my-plugin
cd my-plugin
bun install
synergy plugin validate --runtime-discovery
synergy plugin build
synergy plugin pack
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy plugin publish my-plugin-0.1.0.synergy-plugin.tgz
```
