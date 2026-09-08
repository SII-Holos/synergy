import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { ContinuationWait } from "@ericsanchezok/synergy-harness/session/continuation-wait"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { formatElapsed } from "@ericsanchezok/synergy-harness/util/elapsed"
import { AgendaStore } from "./store"
import { AgendaSessionWakeup } from "./session-wakeup"

export function registerAgendaSessionSignals() {
  SessionExecutionContributions.register({
    id: "agenda",
    ownsPendingReply: (session) => !!session.agenda,
    async advisory(sessionID, scopeID, signal) {
      signal.throwIfAborted()
      const reminder = await buildAgendaReminder(sessionID, scopeID)
      signal.throwIfAborted()
      return reminder ? [reminder] : []
    },
  })
  ContinuationWait.register({
    id: "agenda",
    async list(sessionID) {
      const session = await SessionManager.getSession(sessionID)
      if (!session) return []
      const response = await AgendaSessionWakeup.list(sessionID, session.scope.id)
      return response.items.map((item) => ({ owner: "agenda", id: item.itemID, description: item.title }))
    },
  })
}
/**
 * Build an agenda reminder — tells the agent about pending agenda items that
 * will wake this session (agenda_watch items with delay triggers) so it
 * doesn't need to poll or set redundant watches.
 */
export async function buildAgendaReminder(sessionID: string, scopeID: string): Promise<string | undefined> {
  const items = (await AgendaStore.listForScope(scopeID)).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    wake: item.wake,
    originSessionID: item.origin.sessionID ?? "",
    nextRunAt: item.state.nextRunAt,
  }))
  const now = Date.now()

  // Filter to items that:
  // 1. Are active/pending
  // 2. Have wake !== false (will wake the session)
  // 3. Originate from this session (origin.sessionID === sessionID)
  // 4. Have a delay or at trigger with a future nextRunAt
  const waking = items.filter((item) => {
    if (item.status !== "active" && item.status !== "pending") return false
    if (item.wake === false) return false
    if (item.originSessionID !== sessionID) return false
    if (item.nextRunAt === undefined || item.nextRunAt <= now) return false
    return true
  })

  if (waking.length === 0) return undefined

  const lines = waking.map((item) => {
    const remaining = item.nextRunAt! - now
    const remainingStr = formatElapsed(remaining)
    return `- **\`${item.id}\`** "${item.title}" will wake this session in ~${remainingStr}`
  })

  return [
    `<agenda-reminder>`,
    `The following agenda items will automatically wake this session when they fire:`,
    ...lines,
    `Do NOT set up redundant \`agenda_watch\` calls — the system handles waking you automatically.`,
    `</agenda-reminder>`,
  ].join("\n")
}
