import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { randomBytes } from "node:crypto"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"

type Role = "viewer" | "host"

interface TicketRecord {
  ownerKey: string
  pageId: string
  role: Role
  expiresAt: number
}

const TTL_MS = 60_000
const MAX_TICKETS = 2_048
const runtimeState = RuntimeContext.state(() => ({
  tickets: new Map<string, TicketRecord>(),
}))

export namespace BrowserTicket {
  export interface Issued {
    ticket: string
    expiresAt: number
  }

  export function issue(owner: BrowserOwner.Info, pageId: string, role: Role): Issued {
    const instanceState = runtimeState()

    prune()
    if (instanceState.tickets.size >= MAX_TICKETS) {
      const oldest = instanceState.tickets.keys().next().value
      if (oldest) instanceState.tickets.delete(oldest)
    }
    const ticket = randomBytes(32).toString("base64url")
    const record = { ownerKey: BrowserOwner.key(owner), pageId, role, expiresAt: Date.now() + TTL_MS }
    instanceState.tickets.set(ticket, record)
    return { ticket, expiresAt: record.expiresAt }
  }

  export function consume(owner: BrowserOwner.Info, pageId: string, role: Role, ticket: string | undefined): void {
    const instanceState = runtimeState()

    prune()
    if (!ticket) throw rejected("A Browser signaling ticket is required.")
    const record = instanceState.tickets.get(ticket)
    if (record) instanceState.tickets.delete(ticket)
    if (!record) throw rejected("The Browser signaling ticket is invalid or has already been used.")
    if (record.expiresAt <= Date.now()) throw rejected("The Browser signaling ticket has expired.")
    if (record.ownerKey !== BrowserOwner.key(owner) || record.pageId !== pageId || record.role !== role) {
      throw rejected("The Browser signaling ticket does not match this owner, page, and role.")
    }
  }

  export function revoke(owner: BrowserOwner.Info, pageId?: string): void {
    const instanceState = runtimeState()

    const ownerKey = BrowserOwner.key(owner)
    for (const [ticket, record] of instanceState.tickets) {
      if (record.ownerKey === ownerKey && (!pageId || record.pageId === pageId)) instanceState.tickets.delete(ticket)
    }
  }

  export function resetForTest(): void {
    const instanceState = runtimeState()

    instanceState.tickets.clear()
  }
}

function prune(): void {
  const instanceState = runtimeState()

  const now = Date.now()
  for (const [ticket, record] of instanceState.tickets)
    if (record.expiresAt <= now) instanceState.tickets.delete(ticket)
}

function rejected(message: string): BrowserProtocolError {
  return new BrowserProtocolError({
    code: "browser_ticket_rejected",
    message,
    retryable: true,
  })
}
