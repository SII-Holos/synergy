import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { registerConfig } from "../../src/config-schema"
import { registerWorkspaceFileSymbolSource } from "../../src/workspace-symbol-source"
import { registerLspToolSource } from "../../src/tool-source"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        registerConfig()
        registerWorkspaceFileSymbolSource()
        registerLspToolSource()
      },
    },
  })
}
