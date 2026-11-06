import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ObservabilityBrowserMetrics } from "../../src/observability/browser-metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { clearObservabilityState, resetObservabilityState } from "./fixture"

test("buffered navigation metrics retain their own attribution after the page changes", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => {
    resetObservabilityState()
    try {
      ObservabilityBrowserMetrics.ingest({
        sentAt: Date.now(),
        page: {
          sessionID: "ses_current",
          scopeID: "scope_current",
          correlationId: "nav_current",
          navigationId: "nav_current",
          sessionSwitchId: "switch_current",
        },
        metrics: [
          {
            name: "frontend.session_switch.duration",
            value: 321,
            unit: "ms",
            labels: {
              sessionID: "ses_previous",
              scopeID: "scope_previous",
              correlationId: "nav_previous",
              navigationId: "nav_previous",
              sessionSwitchId: "switch_previous",
              trigger: "sidebar",
            },
          },
        ],
      })
      const [row] = ObservabilityStore.queryMetrics({ since: 0, names: ["frontend.session_switch.duration"] })
      expect(row.session_id).toBe("ses_previous")
      expect(row.scope_id).toBe("scope_previous")
      expect(row.correlation_id).toBe("nav_previous")
      expect(JSON.parse(row.labels_json)).toMatchObject({
        navigationId: "nav_previous",
        sessionSwitchId: "switch_previous",
        trigger: "sidebar",
      })
    } finally {
      clearObservabilityState()
    }
  })
})

test("navigation ingestion retains known triggers and safe metric IDs without widening free-text labels", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => {
    resetObservabilityState()
    try {
      const triggers = ["sidebar", "sidebar-flyout", "session-link", "alt+arrowdown", "alt+arrowup", "key"]
      ObservabilityBrowserMetrics.ingest({
        sentAt: Date.now(),
        page: { sessionID: "ses_page", correlationId: "nav_page" },
        metrics: [...triggers, "prompt: private text"].map((trigger, value) => ({
          name: "frontend.session_switch.duration",
          value,
          unit: "ms",
          labels: {
            trigger,
            navigationId: "nav_metric",
            sessionSwitchId: "switch_metric",
            sessionID: "sk-private-secret",
          },
        })),
      })
      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["frontend.session_switch.duration"] })
      expect(rows).toHaveLength(triggers.length + 1)
      const labels = rows.map((row) => JSON.parse(row.labels_json))
      expect(new Set(labels.flatMap((label) => label.trigger ?? []))).toEqual(new Set(triggers))
      expect(
        labels.every((label) => label.navigationId === "nav_metric" && label.sessionSwitchId === "switch_metric"),
      ).toBe(true)
      expect(rows.every((row) => row.session_id === "ses_page" && row.correlation_id === "nav_page")).toBe(true)
      expect(JSON.stringify(rows)).not.toContain("private")
    } finally {
      clearObservabilityState()
    }
  })
})
