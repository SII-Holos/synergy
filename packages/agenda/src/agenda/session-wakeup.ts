import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { AgendaStore } from "./store"
import type { AgendaTypes } from "./types"

export namespace AgendaSessionWakeup {
  type InstructionProvider = (input: {
    session: SessionInfo
    item: AgendaTypes.Item
  }) => Promise<LoopInstruction | undefined>
  const instructionProviders = RuntimeContext.state(() => new Map<string, InstructionProvider>())
  export function registerInstruction(owner: string, provider: InstructionProvider) {
    RuntimeContext.assertCompositionOpen("Agenda wakeup instructions")
    if (instructionProviders().has(owner)) throw new Error(`Duplicate Agenda instruction ${owner}`)
    instructionProviders().set(owner, provider)
  }
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
    for (const provider of instructionProviders().values()) {
      const result = await provider(input)
      if (result) return result
    }
  }

  export async function resumeIfReleased(input: { before: AgendaTypes.Item; after?: AgendaTypes.Item }): Promise<void> {
    if (!isBlocker(input.before) || (input.after && isBlocker(input.after))) return

    const sessionID = input.before.origin.sessionID
    if (!sessionID) return
    if (await has(sessionID, input.before.origin.scope.id)) return

    const { SessionDrive } = await import("@ericsanchezok/synergy-harness/session/drive")
    void SessionDrive.request(sessionID, "agenda-wait-released").catch((error) => {
      log.error("failed to resume continuation after Agenda release", {
        sessionID,
        itemID: input.before.id,
        error,
      })
    })
  }

  export function cleanupInstructions(wakeups: Awaited<ReturnType<typeof list>>): string[] {
    if (!wakeups.hasActiveAgenda) return ["No remaining Agenda watch holds continuation for this session."]

    const lines = ["Remaining Agenda watches holding continuation for this session:"]
    lines.push(...wakeups.items.map((item) => `- \`${item.itemID}\`: agenda_cancel(id="${item.itemID}")`))
    if (wakeups.hasMore) lines.push("- Additional Agenda watches exist. Use agenda_list to inspect and cancel them.")
    return lines
  }
}
