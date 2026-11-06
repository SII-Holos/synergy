import { expect, test } from "bun:test"
import { updateBrowserActivities } from "../src/activity"
import type { BrowserAgentActivity } from "../src/protocol"

const activity = (sessionID: string, operationID: string): BrowserAgentActivity => ({
  sessionID,
  operationID,
  pageId: "shared",
  url: "https://example.com",
  kind: "reading",
  tool: "browser_read",
  label: "Reading",
})

test("shared pages retain independent operations and failed reads preserve the last viewed page", () => {
  const one = activity("one", "call"),
    two = activity("two", "call")
  let state = updateBrowserActivities([], one)
  state = updateBrowserActivities(state, two)
  expect(state).toHaveLength(2)
  state = updateBrowserActivities(state, { ...one, kind: "idle" })
  expect(state.find((item) => item.sessionID === "two")?.kind).toBe("reading")
  state = updateBrowserActivities(state, { ...one, operationID: "failed" })
  state = updateBrowserActivities(state, { ...one, operationID: "failed", kind: "idle", completed: false })
  expect(state.filter((item) => item.sessionID === "one")).toEqual([{ ...one, kind: "idle" }])
  expect(updateBrowserActivities(state, { ...one, operationID: "unknown", kind: "idle" })).toEqual(state)
})

test("activity snapshots stay bounded and discard idle history before active operations", () => {
  let state: BrowserAgentActivity[] = [activity("active", "running")]
  for (let i = 0; i < 300; i++) {
    const item = activity(`session-${i}`, `op-${i}`)
    state = updateBrowserActivities(state, item)
    state = updateBrowserActivities(state, { ...item, kind: "idle" })
  }
  expect(state).toHaveLength(256)
  expect(state[0]?.operationID).toBe("running")
  expect(state.at(-1)?.sessionID).toBe("session-299")
})
