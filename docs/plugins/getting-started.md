# Plugin Getting Started

## Create a Project

Use Bun and the plugin kit:

```bash
bunx @ericsanchezok/synergy-plugin-kit create my-plugin --template workbench-panel
cd my-plugin
bun install
```

Available templates are `tool-ui`, `workbench-panel`, `navigation`, `api-connector`, and `theme-icon`.

The generated project exports one definition from `src/index.ts`:

```ts
import z from "zod"
import { capability, definePlugin, event, operation, workbenchPanel } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "my-plugin",
  version: "0.1.0",
  description: "My Synergy plugin",
  capabilities: [capability("workspace.read"), capability("ui.hostActions")],
  contributions: [
    event({ id: "data.changed", payload: z.object({ reason: z.string() }) }),
    operation({
      id: "data.get",
      type: "query",
      input: z.object({}),
      output: z.object({ value: z.string() }),
      requires: ["workspace.read"],
      async handler(_input, context) {
        return { value: (await context.workspace?.read?.("data.txt")) ?? "" }
      },
    }),
    workbenchPanel({
      id: "main",
      label: "My Plugin",
      surface: "side",
      cardinality: "singleton",
      component: { source: "./src/ui.tsx" },
    }),
  ],
})
```

Do not create `plugin.json` in the source project. Validation rejects it.

## Build and Validate

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin test
synergy-plugin pack
```

`build` recreates `dist/`, bundles executable handlers, compiles trusted Solid UI, copies declared assets, and writes generated metadata and integrity hashes. `validate --runtime-discovery` imports the packaged runtime only in the explicit validation step and checks that its handler IDs exactly match generated executable contributions. `pack` archives the already-built `dist/`; it never installs dependencies at install time.

The package contains:

```text
plugin.json
integrity.json
permissions.summary.json
runtime/index.js   # only when executable code exists
ui/index.js        # only when trusted components exist
declared assets
```

## Register a Local Directory

Build first, then register the project or its `dist` directory:

```bash
synergy plugin add file:///absolute/path/to/my-plugin
```

For a directory spec, Synergy uses `dist/plugin.json` when it exists. The Plugins workspace shows the registration under both **Installed** and **Development**. A local registry package is different: it is a catalog artifact and appears under **Discover** when the Local registry source is selected.

## Live Development

Use an isolated Synergy instance with an explicit `SYNERGY_HOME`, then run:

```bash
synergy-plugin dev --server-url http://127.0.0.1:PORT
```

The watcher builds into generation directories under `dist/dev/`. A successful build updates the generation pointer and asks the isolated server to reload atomically. A failed build leaves the previous generation active. Live reload refuses to contact a server unless `SYNERGY_HOME` is explicitly set.

## Publish

Sign the built package and prepare a marketplace entry:

```bash
synergy-plugin sign my-plugin-0.1.0.synergy-plugin.tgz
synergy-plugin publish-market --repo https://github.com/owner/my-plugin
```

Publishing is an explicit command. Build, validate, test, and pack never mutate a remote registry. See [Marketplace](marketplace.md).
