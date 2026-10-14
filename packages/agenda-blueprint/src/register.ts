import { setBlueprintAgendaAssertClear } from "@ericsanchezok/synergy-blueprint/blueprint/tools/blueprint-loop-stop"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-agenda/agenda/session-wakeup"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
export function registerBridge() {
  AgentPromptContributions.register("agenda-blueprint", [
    {
      requiredTools: ["blueprint_loop_stop", "agenda_cancel"],
      render: () =>
        "BlueprintLoop review requires all active Agenda wakeups for this execution session to be cancelled. Review is rejected while any wakeup remains.",
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
            "Once the complete Blueprint is finished and verified, cancel the remaining wakeups and formally request audit through blueprint_loop_stop.",
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
