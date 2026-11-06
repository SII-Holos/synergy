import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { registerPluginLightLoopAdapter } from "@ericsanchezok/synergy-plugin-host/plugin/host-services"
import { setTerminalHookDeliverer } from "@ericsanchezok/synergy-light-loop/light-loop/runtime"
import { lightLoopPluginAdapter } from "./adapter"
export function registerBridge() {
  setTerminalHookDeliverer((...args) => Plugin.deliverHookForPlugin(...args))
  registerPluginLightLoopAdapter(lightLoopPluginAdapter)
}
