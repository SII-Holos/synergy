import type { Info as SessionInfo } from "../session/types"
import { Log } from "../util/log"
import { AgendaStore } from "./store"
import type { AgendaTypes } from "./types"

export namespace AgendaSessionWakeup {
  const log = Log.create({ service: "agenda.session-wakeup" })
  const LIST_LIMIT = 100
  export interface LoopInstruction {
    text: string
    tools: Record<string, boolean>
  }

  export async function list(sessionID: string, scopeID: string) {
    return AgendaStore.listForSessionContinuationBlockers({
      sessionID,
      scopeID,
      limit: LIST_LIMIT,
      offset: 0,
    })
  }

  export async function has(sessionID: string, scopeID: string): Promise<boolean> {
    return (await AgendaStore.listForSessionContinuationBlockers({ sessionID, scopeID, limit: 0, offset: 0 }))
      .hasActiveAgenda
  }

  export function isBlocker(item: AgendaTypes.Item): boolean {
    return AgendaStore.isSessionContinuationBlocker(item)
  }

  export async function assertClear(input: {
    sessionID: string
    scopeID: string
    operation: "Light Loop review" | "BlueprintLoop audit"
  }): Promise<void> {
    const wakeups = await list(input.sessionID, input.scopeID)
    if (!wakeups.hasActiveAgenda) return

    const commands = wakeups.items.map((item) => `- \`${item.itemID}\`: agenda_cancel(id="${item.itemID}")`)
    if (wakeups.hasMore) commands.push("- Additional Agenda items exist. Use agenda_list to inspect and cancel them.")

    throw new Error(
      [
        `Cannot request ${input.operation} while Agenda items can still wake this session.`,
        "Cancel every remaining Agenda item first:",
        ...commands,
        `After cancellation, request ${input.operation} again.`,
      ].join("\n"),
    )
  }

  export async function loopInstruction(input: {
    session: SessionInfo
    item: AgendaTypes.Item
  }): Promise<LoopInstruction | undefined> {
    if (!isBlocker(input.item)) return undefined
    const loopID = input.session.blueprint?.loopID
    const lightLoopActive =
      input.session.workflow?.kind === "lightloop" && !input.session.workflow.stopRequest?.reviewSessionID
    if (!loopID && !lightLoopActive) return undefined

    const scopeID = input.session.scope.id
    const wakeups = await list(input.session.id, scopeID)
    const cleanup = cleanupInstructions(wakeups)

    if (loopID && input.session.blueprint?.loopRole === "execution") {
      const { BlueprintLoopStore } = await import("../blueprint")
      const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
      if (loop?.status === "running" && loop.sessionID === input.session.id) {
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
  }

  export async function resumeIfReleased(input: { before: AgendaTypes.Item; after?: AgendaTypes.Item }): Promise<void> {
    if (!isBlocker(input.before) || (input.after && isBlocker(input.after))) return

    const sessionID = input.before.origin.sessionID
    if (!sessionID) return
    if (await has(sessionID, input.before.origin.scope.id)) return

    const { SessionDrive } = await import("../session/drive")
    void SessionDrive.request(sessionID, "agenda-wait-released").catch((error) => {
      log.error("failed to resume continuation after Agenda release", {
        sessionID,
        itemID: input.before.id,
        error,
      })
    })
  }

  function cleanupInstructions(wakeups: Awaited<ReturnType<typeof list>>): string[] {
    if (!wakeups.hasActiveAgenda) return ["No remaining Agenda watch holds continuation for this session."]

    const lines = ["Remaining Agenda watches holding continuation for this session:"]
    lines.push(...wakeups.items.map((item) => `- \`${item.itemID}\`: agenda_cancel(id="${item.itemID}")`))
    if (wakeups.hasMore) lines.push("- Additional Agenda watches exist. Use agenda_list to inspect and cancel them.")
    return lines
  }
}
