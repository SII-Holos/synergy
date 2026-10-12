import { setBlueprintAgendaAssertClear } from "@ericsanchezok/synergy-blueprint/blueprint/tools/blueprint-loop-stop"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-agenda/agenda/session-wakeup"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
export function registerBridge() {
  AgentPromptContributions.register("agenda-blueprint", [
    {
      requiredTools: ["blueprint_loop_stop", "agenda_cancel"],
      render: () =>
        "Before requesting BlueprintLoop review with blueprint_loop_stop, cancel every active Agenda item that can still wake this session using agenda_cancel. The review request is rejected while any such item remains.",
    },
  ])
  setBlueprintAgendaAssertClear(AgendaSessionWakeup.assertClear)
  AgendaSessionWakeup.registerInstruction("agenda-blueprint", async (input) => {
    const loopID = input.session.blueprint?.loopID
    const scopeID = input.session.scope.id
    const wakeups = await AgendaSessionWakeup.list(input.session.id, scopeID)
    const cleanup = AgendaSessionWakeup.cleanupInstructions(wakeups)
    if (loopID && input.session.blueprint?.loopRole === "execution") {
      const { BlueprintLoopStore } = await import("@ericsanchezok/synergy-blueprint/blueprint")
      const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
      if (loop?.status === "running" && !loop.stopRequest && loop.sessionID === input.session.id) {
        return {
          text: [
            "<blueprint-loop-agenda-wakeup>",
            `Agenda \`${input.item.id}\` woke this BlueprintLoop execution session.`,
            `BlueprintLoop ${loop.id} is still running. Evaluate this Agenda result against the complete Blueprint, its start instruction, current deliverables, and verification evidence.`,
            "This Agenda watch owns the wake-up cadence while it remains active, so ordinary BlueprintLoop continuation is paused.",
            "",
            "If the Blueprint is incomplete, continue the required work and keep or adjust monitoring only when another wake-up is needed.",
            "If the complete Blueprint is finished and verified:",
            "1. Cancel every remaining Agenda watch listed below.",
            "2. Call blueprint_loop_stop with the completion summary and concrete evidence.",
            "Do not request audit while an Agenda watch still holds continuation.",
            "",
            ...cleanup,
            "</blueprint-loop-agenda-wakeup>",
          ].join("\n"),
          tools: { agenda_cancel: true, agenda_list: true, blueprint_loop_stop: true },
        }
      }
    }
  })
}
