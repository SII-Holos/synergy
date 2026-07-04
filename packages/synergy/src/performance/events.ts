import { EventEmitter } from "events"
import type { PerformanceSchema } from "./schema"

export namespace PerformanceEvents {
  export type Event =
    | { type: "performance.issue.raised"; issue: PerformanceSchema.Issue }
    | { type: "performance.trace.ended"; trace: PerformanceSchema.TraceListItem }
    | { type: "performance.collector.dropped"; dropped: number; reason: string }

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
