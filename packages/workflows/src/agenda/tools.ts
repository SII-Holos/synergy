import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
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
 * Agenda domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerAgendaTools(): void {
  Tool.registerInputHistory("agenda", {
    agenda_schedule: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
    agenda_watch: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
    agenda_update: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
    agenda_cancel: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
    agenda_trigger: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
    agenda_logs: {
      id: "agendaItemId",
      title: "agendaTitle",
      description: "agendaDescription",
      prompt: "executionInstructions",
      timeout: { name: "timeoutSeconds", scale: 0.001 },
    },
  })

  const instanceState = runtimeState()

  registerToolGroup()
  if (instanceState.registered) return
  instanceState.registered = true

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
