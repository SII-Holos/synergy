import { RuntimeContext } from "../lifecycle/context"
import { EventEmitter } from "events"
import type { ObservabilitySchema } from "./schema"

export namespace ObservabilityLiveEvents {
  export type Event =
    | { type: "issue.raised"; issue: ObservabilitySchema.Issue }
    | { type: "trace.ended"; trace: ObservabilitySchema.Span }

  const runtimeState = RuntimeContext.state(() => ({
    emitter: new EventEmitter().setMaxListeners(200),
  }))

  export function publish(event: Event) {
    const instanceState = runtimeState()

    instanceState.emitter.emit("event", event)
  }

  export function subscribe(listener: (event: Event) => void) {
    const instanceState = runtimeState()

    instanceState.emitter.on("event", listener)
    return () => instanceState.emitter.off("event", listener)
  }
}
