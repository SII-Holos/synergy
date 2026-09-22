import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { PluginRuntimeManager } from "../plugin-runtime/manager"
import { executePluginHostService } from "./host-services-runtime"

export const pluginRuntimeManager = RuntimeContext.state(() => new PluginRuntimeManager(executePluginHostService))
