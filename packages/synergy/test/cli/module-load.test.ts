import { describe, expect, test } from "bun:test"

// Every CLI command module is a side-effect-free yargs definition. Loading
// them in-process records them in coverage and proves each module evaluates.
const cliModules = [
  "../../src/cli/cmd/acp",
  "../../src/cli/cmd/agent",
  "../../src/cli/cmd/auth",
  "../../src/cli/cmd/browser",
  "../../src/cli/cmd/channel-server",
  "../../src/cli/cmd/channel",
  "../../src/cli/cmd/diagnostics",
  "../../src/cli/cmd/doctor",
  "../../src/cli/cmd/embed",
  "../../src/cli/cmd/export",
  "../../src/cli/cmd/generate",
  "../../src/cli/cmd/holos-server",
  "../../src/cli/cmd/holos",
  "../../src/cli/cmd/import",
  "../../src/cli/cmd/library",
  "../../src/cli/cmd/logs",
  "../../src/cli/cmd/mcp",
  "../../src/cli/cmd/migration",
  "../../src/cli/cmd/models",
  "../../src/cli/cmd/plugin-approve",
  "../../src/cli/cmd/plugin-build",
  "../../src/cli/cmd/plugin-create",
  "../../src/cli/cmd/plugin-entry",
  "../../src/cli/cmd/plugin-info",
  "../../src/cli/cmd/plugin-pack",
  "../../src/cli/cmd/plugin-permissions",
  "../../src/cli/cmd/plugin-publish-market",
  "../../src/cli/cmd/plugin-runtime",
  "../../src/cli/cmd/plugin-server",
  "../../src/cli/cmd/plugin-sign",
  "../../src/cli/cmd/plugin-test",
  "../../src/cli/cmd/plugin-validate",
  "../../src/cli/cmd/plugin",
  "../../src/cli/cmd/run",
  "../../src/cli/cmd/server",
  "../../src/cli/cmd/session",
  "../../src/cli/cmd/start",
  "../../src/cli/cmd/stats",
  "../../src/cli/cmd/status",
  "../../src/cli/cmd/stop",
  "../../src/cli/cmd/uninstall",
  "../../src/cli/cmd/upgrade",
  "../../src/cli/cmd/web",
]

describe("CLI command module loading", () => {
  for (const mod of cliModules) {
    test(`loads ${mod.replace("../../src/", "")}`, async () => {
      await expect(import(mod)).resolves.toBeTruthy()
    })
  }
})
