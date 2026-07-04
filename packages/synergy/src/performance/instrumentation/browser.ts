import { recordMetric } from "./shared"

export namespace BrowserPerformanceInstrumentation {
  export function recordWebVital(name: string, value: number, sessionID?: string, scopeID?: string) {
    recordMetric("browser", "frontend.web_vital", value, "ms", {
      source: "browser",
      sessionID,
      scopeID,
      labels: { name },
    })
  }

  export function recordLongTask(durationMs: number, sessionID?: string, scopeID?: string) {
    recordMetric("browser", "frontend.long_task.duration", durationMs, "ms", { source: "browser", sessionID, scopeID })
  }
}
