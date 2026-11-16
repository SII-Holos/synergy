import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ScopedState } from "../scope/scoped-state"

export namespace SessionPendingWindow {
  const state = ScopedState.create(() => ({ viewID: crypto.randomUUID(), ordinal: 0 }))
  const Input = z.strictObject({
    sessionID: z.string().min(1),
    after: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(64).default(32),
    viewID: z.string().min(1).optional(),
  })
  export type Input = z.input<typeof Input>
  export const Changed = NamedError.create("SessionPendingViewChanged", z.object({ message: z.string() }))

  export function next() {
    const current = state()
    current.ordinal = z
      .number()
      .int()
      .positive()
      .safe()
      .parse(current.ordinal + 1)
    return current.ordinal
  }
  export function page<T extends { sessionID: string }>(input: Input, entries: Iterable<{ ordinal: number; info: T }>) {
    const query = Input.parse(input)
    const current = state()
    if (query.viewID && query.viewID !== current.viewID)
      throw new Changed({ message: "Native pending interaction view changed" })
    const items: Array<{ ordinal: number; info: T }> = []
    let hasMore = false
    for (const entry of entries) {
      if (entry.info.sessionID !== query.sessionID || entry.ordinal <= query.after) continue
      if (items.length === query.limit) {
        hasMore = true
        break
      }
      items.push(entry)
    }
    return { viewID: current.viewID, items, hasMore }
  }
}
