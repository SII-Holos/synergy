import { registerToolGroup } from "../tool-group-agenda"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { AgendaScheduleTool } from "./tools/agenda-schedule"
import { AgendaWatchTool } from "./tools/agenda-watch"
import { AgendaListTool } from "./tools/agenda-list"
import { AgendaUpdateTool } from "./tools/agenda-update"
import { AgendaCancelTool } from "./tools/agenda-cancel"
import { AgendaTriggerTool } from "./tools/agenda-trigger"
import { AgendaLogsTool } from "./tools/agenda-logs"

/**
 * Agenda domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerAgendaTools(): void {
  registerToolGroup()
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("agenda", () => [
    AgendaScheduleTool,
    AgendaWatchTool,
    AgendaListTool,
    AgendaUpdateTool,
    AgendaCancelTool,
    AgendaTriggerTool,
    AgendaLogsTool,
  ])
}
