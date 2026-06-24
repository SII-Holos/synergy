import { describe, expect, test } from "bun:test"
import * as Audit from "../../src/plugin/audit"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Audit: update_failed_rolled_back event type and persistence
// ---------------------------------------------------------------------------

describe("Audit: update_failed_rolled_back event", () => {
  test("recordEvent accepts update_failed_rolled_back type and persists it", async () => {
    const details = {
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      error: "npm install failed",
      rolledBackTo: "1.0.0",
    }

    await Audit.recordEvent({
      pluginId: "test-plugin",
      type: "update_failed_rolled_back",
      details,
    })

    const events = await Audit.getEvents("test-plugin")
    const match = events.find((e) => e.type === "update_failed_rolled_back")
    expect(match).toBeDefined()
    expect(match!.pluginId).toBe("test-plugin")
    expect(match!.details.fromVersion).toBe("1.0.0")
    expect(match!.details.toVersion).toBe("2.0.0")
    expect(match!.details.error).toBe("npm install failed")
    expect(match!.details.rolledBackTo).toBe("1.0.0")
    expect(match!.time).toBeGreaterThan(0)
    expect(match!.id).toBeTruthy()
  })

  test("update_failed_rolled_back events are returned by getEvents with pluginId filter", async () => {
    await Audit.recordEvent({
      pluginId: "plugin-a",
      type: "update_failed_rolled_back",
      details: { fromVersion: "1.0.0", toVersion: "2.0.0", error: "timeout" },
    })
    await Audit.recordEvent({
      pluginId: "plugin-b",
      type: "update_failed_rolled_back",
      details: { fromVersion: "0.5.0", toVersion: "1.0.0", error: "crash" },
    })

    const eventsA = await Audit.getEvents("plugin-a")
    const rollbackA = eventsA.filter((e) => e.type === "update_failed_rolled_back")
    expect(rollbackA.length).toBeGreaterThanOrEqual(1)
    expect(rollbackA.every((e) => e.pluginId === "plugin-a")).toBe(true)

    const eventsB = await Audit.getEvents("plugin-b")
    const rollbackB = eventsB.filter((e) => e.type === "update_failed_rolled_back")
    expect(rollbackB.length).toBeGreaterThanOrEqual(1)
    expect(rollbackB.every((e) => e.pluginId === "plugin-b")).toBe(true)
  })

  test("getRecentEvents includes update_failed_rolled_back in unfiltered results", async () => {
    await Audit.recordEvent({
      pluginId: "recent-test",
      type: "update_failed_rolled_back",
      details: { error: "test" },
    })

    const recent = await Audit.getRecentEvents(20)
    const match = recent.find((e) => e.type === "update_failed_rolled_back")
    expect(match).toBeDefined()
  })
})
