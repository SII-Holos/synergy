import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { PluginRuntimeManager } from "../plugin-runtime/manager"
import { executePluginHostService } from "./host-services-runtime"

import { PluginInvocationWorkspace } from "./invocation-workspace"
import { startMemoryMonitor } from "../plugin-runtime/resource-limits"

export const pluginRuntimeManager = RuntimeContext.state(
  () =>
    new PluginRuntimeManager(executePluginHostService, {
      startMemoryMonitor,
      withInvocation: PluginInvocationWorkspace.run,
    }),
)
