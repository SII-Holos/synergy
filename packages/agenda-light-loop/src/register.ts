import { setLightLoopAgendaAssertClear } from "@ericsanchezok/synergy-light-loop/light-loop/tools/loop-stop"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-agenda/agenda/session-wakeup"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
export function registerBridge() {
  AgentPromptContributions.register("agenda-light-loop", [
    {
      requiredTools: ["loop_stop", "agenda_cancel"],
      render: () =>
        "Before requesting Light Loop review with loop_stop, cancel every active Agenda item that can still wake this session using agenda_cancel. The review request is rejected while any such item remains.",
    },
  ])
  setLightLoopAgendaAssertClear(AgendaSessionWakeup.assertClear)
  AgendaSessionWakeup.registerInstruction("agenda-light-loop", async (input) => {
    const lightLoopActive = input.session.workflow?.kind === "lightloop" && !input.session.workflow.stopRequest
    const scopeID = input.session.scope.id
    const wakeups = await AgendaSessionWakeup.list(input.session.id, scopeID)
    const cleanup = AgendaSessionWakeup.cleanupInstructions(wakeups)
    if (lightLoopActive && input.session.workflow?.kind === "lightloop") {
      return {
        text: [
          "<light-loop-agenda-wakeup>",
          `Agenda \`${input.item.id}\` woke this Light Loop session.`,
          "Evaluate this Agenda result against the complete task, current work, and verification evidence.",
          "This Agenda watch owns the wake-up cadence while it remains active, so ordinary Light Loop continuation is paused.",
          "",
          "If the task is incomplete, continue the required work and keep or adjust monitoring only when another wake-up is needed.",
          "If the complete task is finished and verified:",
          "1. Cancel every remaining Agenda watch listed below.",
          "2. Call loop_stop with the completion summary and concrete evidence.",
          "Do not request review while an Agenda watch still holds continuation.",
          "",
          ...cleanup,
          "</light-loop-agenda-wakeup>",
        ].join("\n"),
        tools: { agenda_cancel: true, agenda_list: true, loop_stop: true },
      }
    }
  })
}
