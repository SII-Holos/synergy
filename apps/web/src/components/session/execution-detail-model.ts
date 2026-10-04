import { z } from "zod"
import type { ToolActivityTarget } from "@ericsanchezok/synergy-ui/context/resource-open"

const State = z.object({
  server: z.string().min(1),
  scope: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  partID: z.string().min(1),
  callID: z.string().optional(),
})
export type ExecutionDetailState = z.infer<typeof State>
export type ExecutionDetailOwner = Pick<ExecutionDetailState, "server" | "scope" | "sessionID">

export function executionDetailState(value: unknown, owner: ExecutionDetailOwner): ExecutionDetailState | undefined {
  const parsed = State.safeParse(value)
  if (!parsed.success) return
  const state = parsed.data
  return state.server === owner.server && state.scope === owner.scope && state.sessionID === owner.sessionID
    ? state
    : undefined
}

export function executionDetailSelection(state: ExecutionDetailState): ToolActivityTarget {
  return {
    sessionID: state.sessionID,
    messageID: state.messageID,
    partID: state.partID,
    ...(state.callID ? { callID: state.callID } : {}),
  }
}
