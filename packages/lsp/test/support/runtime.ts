import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"
import { registerWorkspaceFileSymbolSource } from "../../src/workspace-symbol-source"
import { registerLspToolSource } from "../../src/tool-source"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerWorkspaceFileSymbolSource()
        registerLspToolSource()
      },
    },
  })
}
