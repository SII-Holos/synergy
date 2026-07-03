# Plugin Toolchain

**Source of truth:** `packages/plugin-kit/src/commands/*.ts` for authoring commands and `packages/synergy/src/cli/cmd/plugin-*.ts` for runtime/install commands.

The supported plugin development flow is:

```bash
bunx @ericsanchezok/synergy-plugin-kit create <name> --template <template>
cd <name>
bun install
synergy-plugin dev
synergy-plugin validate --runtime-discovery
synergy-plugin publish-market
```

Generated project scripts such as `bun run validate`, `bun run build`, `bun run pack`, `bun run sign`, and `bun run publish:market` call the same kit commands and are useful for CI or manual fallback flows.

Local installation uses the same resolver as runtime loading:

```bash
synergy plugin add file:///absolute/path/to/plugin
synergy plugin add file:///absolute/path/to/plugin/src/index.ts
synergy plugin add file:///absolute/path/to/plugin-0.1.0.synergy-plugin.tgz
synergy plugin add npm-package-name
synergy plugin add github:owner/repo
```

## Descriptor Contract

Plugin runtime code exports a `PluginDescriptor` object:

```ts
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"

export const plugin: PluginDescriptor = {
  id: "my-plugin",
  async init(input) {
    return {}
  },
}

export default plugin
```

`plugin.id` must match `plugin.json.name`. Validation and loading fail on mismatch.

## Tool Result Presentation

Tools that generate a primary visual attachment can return standard `attachments` and set:

```ts
metadata: {
  display: {
    toolCard: "hidden",
  },
}
```

The Web client hides the tool card and renders returned attachments at the original tool-call position in the message. Each attachment controls its own display with `presentation.hidden`, `presentation.renderer`, `presentation.size`, and `presentation.crop`. Use `input.client.asset.upload()` or the public `/asset` route to create `asset://...` URLs; plugins should not import Synergy internal asset modules.

For generated media, also declare display metadata on the tool definition and in `plugin.json`:

```ts
tool({
  description: "Generate an image",
  display: {
    kind: "media-generation",
    toolCard: "hidden",
    media: {
      type: "image",
      aspectRatio: "1:1",
    },
  },
  args: {
    prompt: tool.schema.string(),
  },
  async execute(args, context) {
    // Upload the attachment and return it with attachment-level presentation.
  },
})
```

`media-generation` tools use Synergy's built-in placeholder while running. `toolCard: "hidden"` keeps the tool card itself out of the transcript when the media surface owns the experience; completed success states render returned non-hidden attachments in place. Optional `media.actionLabel` and `media.pendingTitle` are accessibility labels, not transcript copy. Do not rely on tool input fields such as `prompt` being displayed by the host.

## Internal Helpers And Planners

Use `exposure: { mode: "internal" }` for helper tools that should be available only to a host-controlled flow such as a delegated subagent. Internal tools are not resident, not grouped, and not discoverable through `search_tools`.

A public tool can call `context.task.run()` to launch a Synergy delegated subagent with an explicit tool allowlist:

```ts
await context.task?.run({
  subagent: "my-plugin-planner",
  description: "Plan result",
  prompt: "Return a valid JSON plan.",
  tools: {
    "*": false,
    "plugin__my-plugin__private_helper": true,
  },
  visibility: "hidden",
  timeoutMs: 120_000,
  output: {
    mode: "structured",
    schema: { type: "object" },
    maxRepairTurns: 3,
  },
})
```

Declare `permissions.tools.task` in `plugin.json` before using this service. `output.mode: "structured"` is a Cortex-native output contract: Cortex validates the child result and stores it on `task.outputResult`, while `task.result` remains the normal trajectory summary.

## Runtime Limits

Plugin runtime limits are configured through the plugin config domain, then optionally narrowed or raised by each plugin manifest:

```jsonc
// ~/.synergy/config/synergy.d/50-plugins.jsonc
// <project>/.synergy/synergy.d/50-plugins.jsonc
{
  "pluginRuntimePolicy": {
    "limits": {
      "startupTimeoutMs": 15000,
      "toolInvocationTimeoutMs": 120000,
      "hookInvocationTimeoutMs": 120000,
      "bridgeRequestTimeoutMs": 120000,
      "taskRunTimeoutMs": 120000,
      "shutdownGraceMs": 1500,
      "maxConcurrentRequests": 8,
      "maxLogBytesPerMinute": 128000,
      "memoryMb": 256,
      "memoryPollIntervalMs": 10000,
      "heartbeatIntervalMs": 5000,
      "heartbeatMissesBeforeKill": 3,
    },
  },
}
```

The host resolves limits in one place: Synergy config first, `plugin.json.runtime.resources` second. Worker and process runtimes, bridge calls, delegated tasks, and runtime restart matching all consume that resolved limit object.

## create

```bash
synergy-plugin create <name> [--template tool-ui|workbench-panel|api-connector|theme-icon]
```

Generated projects include `plugin.json`, `package.json`, `tsconfig.json`, runtime source, and any template UI/assets.

Templates:

| Template          | Output                                                       |
| ----------------- | ------------------------------------------------------------ |
| `tool-ui`         | Runtime tool plus Solid tool renderer source at `src/ui.tsx` |
| `workbench-panel` | Workbench panel UI source at `src/ui.tsx`                    |
| `api-connector`   | Network-enabled runtime tools plus tool renderers            |
| `theme-icon`      | Theme CSS and SVG icon assets with no UI JS entry            |

## validate

```bash
synergy-plugin validate [path] [--runtime-discovery]
```

Validation checks:

- manifest schema and required identity fields
- canonical plugin id consistency
- UI entry/export declarations
- runtime policy warnings
- declared tool capabilities
- with `--runtime-discovery`, the descriptor is imported, `init()` is called in a dev-safe context, and runtime tools are compared with `contributes.tools`

## dev

```bash
synergy plugin dev [path] [--sandbox-preview]
```

Development mode validates the manifest, prints permission and runtime previews, watches plugin source, and reloads plugin state on changes.

## build

```bash
synergy-plugin build [path]
```

Build output is written to `dist/`:

- backend runtime bundle: `dist/runtime/index.js`
- normalized manifest: `dist/plugin.json`
- UI bundle: the path declared by `contributes.ui.entry`, normally `dist/ui/index.js`
- copied `public/assets`, `themes`, and `icons`
- `dist/permissions.summary.json`
- `dist/integrity.json`

`contributes.ui.entry` is a distributable JavaScript asset path. If it is declared, build looks for `src/ui.tsx`, `src/ui/index.tsx`, `src/ui.ts`, or `src/ui/index.ts` and compiles that source to the declared entry.

## pack

```bash
synergy-plugin pack [path]
```

Creates `<name>-<version>.synergy-plugin.tgz` from `dist/`. The archive must contain installable runtime assets, `plugin.json`, UI assets, permission summary, and integrity metadata.

## sign

```bash
synergy-plugin sign <tarball>
```

Signs the plugin archive metadata with the local Ed25519 signing key under the configured Synergy home keys directory and writes `<tarball>.sig`.

## publish-market

```bash
synergy-plugin publish-market [tarball]
```

Validates, builds, packs, signs, prepares GitHub Release assets, writes or updates `SII-Holos/synergy-plugins/plugins/<id>.json`, regenerates `registry.json`, runs registry validation, and opens a PR when `gh` is installed and authenticated. If upload, push, or PR creation cannot be automated, the command prints the exact manual fallback.

For CI or manual workflows, generate only the aggregator entry:

```bash
synergy-plugin entry <tarball> \
  --repo https://github.com/owner/my-plugin \
  --write-entry ../synergy-plugins/plugins/<name>.json
```

`entry` does not upload assets or mutate the remote registry. Use `--download-url` and `--signature-url` when the release asset URLs cannot be inferred from `--repo` and `v<version>`. The generated entry includes the Ed25519 signer public key from `<tarball>.sig` and copies `plugin.json` `engines.synergy` into `compatibility.synergy`; the official registry CI verifies the signer before the plugin is installable from the Official source.

## local publish

```bash
synergy plugin publish <tarball>
```

Accepts `.synergy-plugin.tgz` or `.tgz`, inspects the packaged `plugin.json`, copies the real artifact to the local registry artifact store, computes `sha256-...` integrity, and publishes metadata with a `file://` download URL.

## Registry Install

The Web marketplace and `install-from-registry` route install the selected registry source/version. Official installs download the release artifact, verify `sha256-...` integrity, verify the signature with the registry-reviewed signer public key, inspect the package contents, request approval when needed, and then install the cached tarball. Local registry installs use the local artifact `downloadUrl` and preserve the previous development workflow.
