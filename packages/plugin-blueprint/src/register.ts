import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { registerPluginBlueprintAdapter } from "@ericsanchezok/synergy-plugin-host/plugin/host-services"
import { setTerminalHookDeliverer } from "@ericsanchezok/synergy-blueprint/blueprint/terminal-hook"
import { startBlueprint, getBlueprint, cancelBlueprint } from "./adapter"
export function registerBridge() {
  setTerminalHookDeliverer((...args) => Plugin.deliverHookForPlugin(...args))
  registerPluginBlueprintAdapter({ start: startBlueprint, get: getBlueprint, cancel: cancelBlueprint })
}
