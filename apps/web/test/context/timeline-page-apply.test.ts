import { expect, test } from "bun:test"
import { planMessagePageApply } from "../../src/context/session-message-page"

test("a message summary page changes the window without asserting empty canonical Parts", () => {
  const info = { id: "msg_one", sessionID: "session", role: "user" as const, time: { created: 1 } }
  const plan = planMessagePageApply({
    page: {
      items: [{ info, order: "one", version: "version" }],
      referencedRoots: [],
      nextCursor: null,
      hasMore: false,
      total: 1,
    },
  })
  expect(plan.window.messages).toEqual([info])
  expect(plan.parts).toEqual({})
})

test("locating an older window replaces unrelated headers and preserves the independent latest context", () => {
  const info = { id: "old", sessionID: "session", role: "user" as const, time: { created: 1 } }
  const plan = planMessagePageApply({
    page: { items: [{ info }], referencedRoots: [], nextCursor: "earlier", hasMore: true, total: 200 },
    current: {
      messages: [{ ...info, id: "latest", time: { created: 200 } }],
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: false,
    },
    mode: "history",
    replace: true,
  })
  expect(plan.window.messages.map((message) => message.id)).toEqual(["old"])
  expect(plan.droppedIds).toEqual(["latest"])
  expect(plan.window.mode).toBe("history")
  expect(plan.window.tailMissingLatest).toBe(true)
  expect(plan.latestContextMessage).toBeUndefined()
})
