import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { registerAgendaHooks } from "@ericsanchezok/synergy-agenda/agenda/hooks"
export function registerBridge() {
  registerAgendaHooks((name, input, output) => Plugin.trigger(name, input, output))
}
