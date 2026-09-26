import {
  run as runServerRuntime,
  type RuntimeOptions as ServerRuntimeOptions,
} from "@ericsanchezok/synergy-cli/server/runtime"
import { StartupReporter } from "@ericsanchezok/synergy-cli/cli/startup-reporter"
import { pluginStatus } from "@ericsanchezok/synergy-plugin-host/startup-status"
import { connectionStatusRows } from "@ericsanchezok/synergy-connections/startup-status"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { PresetRuntimeHandle } from "./runtime-handle"

export type RuntimeOptions = Omit<ServerRuntimeOptions, "runtimeFactory" | "status">
export function run(options: RuntimeOptions) {
  return runServerRuntime({
    ...options,
    runtimeFactory: PresetRuntimeHandle.open,
    status: (printUpdates) =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => [
          await pluginStatus(),
          ...(printUpdates
            ? await connectionStatusRows((statuses) =>
                StartupReporter.print({ title: "Synergy connection update", statuses }),
              )
            : []),
        ],
      }),
  })
}
