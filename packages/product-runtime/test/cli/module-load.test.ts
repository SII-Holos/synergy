import { describe, expect, test } from "bun:test"

// Every CLI command module is a side-effect-free yargs definition. Loading
// them in-process records them in coverage and proves each module evaluates.
const cliModules = [
  "../../../agent-integrations/src/acp/cli/acp",
  "../../../cli/src/cli/cmd/agent",
  "../../../cli/src/cli/cmd/auth",
  "../../../browser-runtime/src/cli/browser",
  "../../../connections/src/channel/cli/channel-server",
  "../../../connections/src/channel/cli/channel",
  "../../../cli/src/cli/cmd/diagnostics",
  "../../../cli/src/cli/cmd/doctor",
  "../../../library/src/cli/embed",
  "../../../cli/src/cli/cmd/export",
  "../../src/cli/generate",
  "../../../connections/src/holos/cli/holos-server",
  "../../../connections/src/holos/cli/holos",
  "../../../cli/src/cli/cmd/import",
  "../../../library/src/cli/library",
  "../../../cli/src/cli/cmd/logs",
  "../../../agent-integrations/src/mcp/cli/mcp",
  "../../../cli/src/cli/cmd/migration",
  "../../../cli/src/cli/cmd/models",
  "../../../plugin-host/src/plugin/cli/plugin-approve",
  "../../../plugin-host/src/plugin/cli/plugin-build",
  "../../../plugin-host/src/plugin/cli/plugin-create",
  "../../../plugin-host/src/plugin/cli/plugin-entry",
  "../../../plugin-host/src/plugin/cli/plugin-info",
  "../../../plugin-host/src/plugin/cli/plugin-pack",
  "../../../plugin-host/src/plugin/cli/plugin-permissions",
  "../../../plugin-host/src/plugin/cli/plugin-publish-market",
  "../../../plugin-host/src/plugin/cli/plugin-runtime",
  "../../../plugin-host/src/plugin/cli/plugin-server",
  "../../../plugin-host/src/plugin/cli/plugin-sign",
  "../../../plugin-host/src/plugin/cli/plugin-test",
  "../../../plugin-host/src/plugin/cli/plugin-validate",
  "../../../plugin-host/src/plugin/cli/plugin",
  "../../../cli/src/cli/cmd/run",
  "../../src/cli/server",
  "../../../cli/src/cli/cmd/session",
  "../../../cli/src/cli/cmd/start",
  "../../../workbench/src/stats/cli/stats",
  "../../../cli/src/cli/cmd/status",
  "../../../cli/src/cli/cmd/stop",
  "../../../cli/src/cli/cmd/uninstall",
  "../../../cli/src/cli/cmd/upgrade",
  "../../src/cli/web",
]

describe("CLI command module loading", () => {
  for (const mod of cliModules) {
    test(`loads ${mod.replace("../../../cli/src/", "")}`, async () => {
      await expect(import(mod)).resolves.toBeTruthy()
    })
  }
})
