import { EventEmitter } from "events"
import type { ObservabilitySchema } from "./schema"

export namespace ObservabilityLiveEvents {
  export type Event =
    | { type: "issue.raised"; issue: ObservabilitySchema.Issue }
    | { type: "trace.ended"; trace: ObservabilitySchema.Span }

  const emitter = new EventEmitter()
  emitter.setMaxListeners(200)

  export function publish(event: Event) {
    emitter.emit("event", event)
  }

  export function subscribe(listener: (event: Event) => void) {
    emitter.on("event", listener)
    return () => emitter.off("event", listener)
  }
}
