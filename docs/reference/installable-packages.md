# Installable Packages

Start with `@ericsanchezok/synergy-cli`, then install the mechanisms your agent needs:

```sh
bun install -g @ericsanchezok/synergy-cli
synergy install mcp lsp server
synergy list --json
synergy remove lsp
```

`full` selects the complete backend, `web` adds the Web application, and `desktop` adds the native shell. The existing complete product distribution keeps its full selection. Built-in selections resolve to the running host version. See [Package map](packages.md#installation-commands) for trust, upgrade, rollback and activation semantics, and [Embedding](embedding.md) for direct Bun, Node.js and HTTP integration.

## Company presets

A preset is an ordinary npm package with declarative `synergy` metadata. It selects dependencies without copying the Harness or executing a setup script. This example uses `1.1.26`; replace every host/dependency version with the exact Synergy release your company has validated:

```json
{
  "name": "@company/synergy-preset",
  "version": "1.0.0",
  "dependencies": {
    "@ericsanchezok/synergy-mcp": "1.1.26",
    "@ericsanchezok/synergy-lsp": "1.1.26",
    "@ericsanchezok/synergy-server": "1.1.26"
  },
  "synergy": {
    "formatVersion": 1,
    "kind": "preset",
    "id": "company-agent",
    "version": "1.0.0",
    "compatibility": { "synergy": "1.1.26" },
    "packages": {
      "@ericsanchezok/synergy-mcp": "1.1.26",
      "@ericsanchezok/synergy-lsp": "1.1.26",
      "@ericsanchezok/synergy-server": "1.1.26"
    }
  }
}
```

The npm dependency map carries installation; `synergy.packages` declares the selected mechanism graph. Keep them aligned. Configure private registry access through Bun's user npm configuration, outside the published package. Test the directory or archive before publishing it to your company registry:

```sh
synergy install ./company-preset --trust-host-code
synergy list --json
synergy remove company-agent
synergy install @company/synergy-preset@1.0.0 --trust-host-code
```

Unattended installation needs the explicit trust flag. Dependency ownership is visible in `list`; removing a preset prunes dependencies that no retained root needs. Installed code becomes active at the next start. An embedded `openAgentRuntime` keeps using its explicit factory list regardless of installed presets.

## Trusted host components

Use a component when a mechanism must contribute host configuration, migrations, workers, transport adapters or lifecycle services. Ordinary agent tools and integrations can use [Plugin API 4](../plugins/getting-started.md), which keeps process execution and capability grants. MCP and LSP are host components; installing them does not grant individual tools permission to act.

A component publishes the [`RuntimeComponent`](../../packages/harness/src/lifecycle/components.ts) factory through a normal package export. Its `package.json.synergy` identifies the same factory and dependencies before code is imported:

```json
{
  "formatVersion": 1,
  "kind": "component",
  "id": "company-settings",
  "version": "1.0.0",
  "compatibility": { "synergy": "1.1.26" },
  "apiVersion": 1,
  "entry": "./dist/component.js",
  "export": "companySettings",
  "requires": { "local-runtime": "1.1.26" }
}
```

For example, a company-owned configuration schema registers only when the component is selected:

```ts
import { z } from "zod"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config"

export function companySettings(): RuntimeComponent {
  return {
    id: "company-settings",
    version: "1.0.0",
    apiVersion: 1,
    requires: { "local-runtime": "1.1.26" },
    register() {
      ConfigExtensions.register("company-settings", {
        shape: { company: z.object({ team: z.string() }).optional() },
      })
    },
  }
}
```

Declare Harness as a compatible peer and `zod` as a dependency; compile the component as ESM with external imports. Do not bundle a second Harness. Export `./component` to the compiled file for direct Bun consumers, who can pass `companySettings()` to `openAgentRuntime`. Keep factory identity, version and requirements identical to metadata. Use `synergy.packages` and matching npm dependencies when your component requires other optional mechanisms.

Registration is synchronous and Runtime-scoped. Open resources through lifecycle services, return cleanup through the owning lifecycle, and declare worker or HTTP/CLI adapters only when needed. Importing the module must not activate the mechanism. The host validates dependency order, versions, entry containment and canonical Harness identity before activation. See [Runtime and Scope](../architecture/runtime-and-scope.md#composition-and-migration-registration).

Package lifecycle scripts are disabled during resolution. Ship complete compiled resources in the archive. API4 plugin wrappers point to the Plugin Kit-generated manifest and retain separate capability approval; their API family remains `4.0`. Native application packages bind platform payloads to HTTPS URLs, checksums and native publisher metadata through the [outer package schema](../../packages/plugin/src/package.ts).
