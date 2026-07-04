import { recordMetric, startSpan } from "./shared"
import { PerformanceSpans } from "../spans"

export namespace SessionPerformanceInstrumentation {
  export const startTurnSpan = (input: Parameters<typeof startSpan>[2] = {}) =>
    startSpan("session", "session.turn", input)

  export const endTurnSpan = PerformanceSpans.end

  export function recordActiveTurns(count: number, sessionID?: string) {
    recordMetric("session", "session.active_turns", count, "count", { sessionID })
  }
}
