import { registerMcpToolSource } from "../../src/mcp/tool-source"
import { registerWorkspaceFileSymbolSource } from "../../src/lsp/workspace-symbol-source"
import { registerExternalAdapters } from "../../src/external-agent"
import { registerLspToolSource } from "../../src/lsp/tool-source"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerMcpToolSource()
        registerWorkspaceFileSymbolSource()
        registerExternalAdapters()
        registerLspToolSource()
      },
    },
  })
}
