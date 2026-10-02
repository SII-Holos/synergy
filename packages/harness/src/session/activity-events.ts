import { z } from "zod"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { ScopeContext } from "../scope/context"
import type { RolloutSchema } from "./rollout/schema"

export namespace SessionActivityEvent {
  export const Execution = BusEvent.define(
    "session.execution.updated",
    z.object({ sessionID: z.string(), rootID: z.string() }),
  )
  export const Tool = BusEvent.define(
    "session.tool.activity",
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      callID: z.string(),
      processID: z.string(),
      revision: z.number(),
    }),
  )

  export async function execution(owner: RolloutSchema.Owner, rootID: string) {
    if (owner.kind !== "session" || ScopeContext.tryScope()?.id !== owner.scopeID) return
    await Bus.publish(Execution, { sessionID: owner.sessionID, rootID })
  }
  export async function tool(owner: RolloutSchema.Owner, input: Omit<z.infer<typeof Tool.properties>, "sessionID">) {
    if (owner.kind !== "session" || ScopeContext.tryScope()?.id !== owner.scopeID) return
    await Bus.publish(Tool, { sessionID: owner.sessionID, ...input })
  }
}
