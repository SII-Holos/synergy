# Plugin Security Best Practices

## Keep Identity Stable

Use one canonical plugin id everywhere:

- descriptor `id`
- `plugin.json.name`
- registry id
- approval id

Changing the id creates a new trust and approval boundary.

## Declare Minimum Capabilities

Prefer the narrowest manifest permissions:

```jsonc
{
  "permissions": {
    "tools": {
      "invoke": true,
      "filesystem": "none",
      "network": false,
      "shell": false,
      "mcp": "none",
    },
  },
}
```

Declare per-tool capabilities in `contributes.tools`. Avoid plugin-wide `tools.filesystem: "write"`, `tools.shell`, `tools.network`, or `data.secrets` unless every tool needs them.

## Treat Input As Untrusted

Tool args, config values, auth values, network responses, and files read through bridge APIs are untrusted. Validate with Zod or equivalent runtime checks.

## Prefer Runtime APIs

Use plugin `config`, `auth`, and `cache` stores for persistent plugin state. In worker/process mode these stores go through the host bridge and permission enforcement.

## Package Only Build Output

Publish `.synergy-plugin.tgz` archives produced by:

```bash
synergy-plugin build
synergy-plugin pack
synergy-plugin sign <tarball>
```

Do not publish source-only archives. A valid package contains `plugin.json`, `runtime/index.js`, integrity metadata, permission summary, and any declared UI assets.

## Review UI Trust

Use declarative UI where possible. Use trusted imports only for local or explicitly trusted plugins. Use sandbox surfaces for third-party or high-risk UI.
