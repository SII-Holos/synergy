import { PluginRuntimeManager } from "../plugin-runtime/manager"
import { executePluginHostService } from "./host-services-runtime"

export const pluginRuntimeManager = new PluginRuntimeManager(executePluginHostService)
