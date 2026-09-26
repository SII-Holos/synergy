import { expect, test } from "bun:test"
import type { BrowserAPISessionState } from "@ericsanchezok/synergy-browser"
import { createBrowserSessionRecovery } from "../../../../src/components/workspace/browser/browser-session-recovery"
const state = (hostStatus: BrowserAPISessionState["hostStatus"]) =>
  ({ ownerKey: "owner", status: "active", page: { id: "page" }, hostStatus }) as BrowserAPISessionState

test("recovery checks the server before resuming the existing page and reconnecting", async () => {
  const order: string[] = []
  const recovery = createBrowserSessionRecovery({
    ownerKey: "owner",
    pageId: () => "page",
    read: async () => {
      order.push("read")
      return state("failed")
    },
    resume: async () => {
      order.push("resume")
    },
    reconnect: () => {
      order.push("reconnect")
    },
  })
  await recovery.run()
  expect(order).toEqual(["read", "resume", "reconnect"])
})
test("a healthy existing page only reconnects, and overlapping retries share one attempt", async () => {
  let reads = 0
  let resumes = 0
  const recovery = createBrowserSessionRecovery({
    ownerKey: "owner",
    pageId: () => "page",
    read: async () => {
      reads++
      return state("ready")
    },
    resume: async () => {
      resumes++
    },
    reconnect: () => {},
  })
  await Promise.all([recovery.run(), recovery.run()])
  expect(reads).toBe(1)
  expect(resumes).toBe(0)
})
test("failed reads or changed ownership cannot resume or reconnect", async () => {
  for (const read of [
    async () => {
      throw new Error("offline")
    },
    async () => ({ ...state("failed"), ownerKey: "other" }),
    async () => ({ ...state("failed"), page: null }),
  ]) {
    const actions: string[] = []
    const recovery = createBrowserSessionRecovery({
      ownerKey: "owner",
      pageId: () => "page",
      read,
      resume: async () => {
        actions.push("resume")
      },
      reconnect: () => {
        actions.push("reconnect")
      },
    })
    await expect(recovery.run()).rejects.toThrow()
    expect(actions).toEqual([])
  }
})
test("leaving a session aborts recovery before any later resume or reconnect", async () => {
  let complete!: (state: BrowserAPISessionState) => void
  const actions: string[] = []
  const recovery = createBrowserSessionRecovery({
    ownerKey: "owner",
    pageId: () => "page",
    read: () =>
      new Promise((resolve) => {
        complete = resolve
      }),
    resume: async () => {
      actions.push("resume")
    },
    reconnect: () => {
      actions.push("reconnect")
    },
  })
  const pending = recovery.run()
  recovery.dispose()
  complete(state("failed"))
  await pending
  expect(actions).toEqual([])
})

test("an explicit retry resumes the retained page after a failed restart checkpoint", async () => {
  const actions: string[] = []
  const recovery = createBrowserSessionRecovery({
    ownerKey: "owner",
    pageId: () => "page",
    read: async () => ({ ...state("detached"), status: "failed" }),
    resume: async () => {
      actions.push("resume")
    },
    reconnect: () => {
      actions.push("reconnect")
    },
  })
  await recovery.run()
  expect(actions).toEqual(["resume", "reconnect"])
})

test("an intentionally suspended page is not activated by connection recovery", async () => {
  const actions: string[] = []
  const recovery = createBrowserSessionRecovery({
    ownerKey: "owner",
    pageId: () => "page",
    read: async () => ({ ...state("detached"), status: "suspended" }),
    resume: async () => {
      actions.push("resume")
    },
    reconnect: () => {
      actions.push("reconnect")
    },
  })
  await expect(recovery.run()).rejects.toThrow()
  expect(actions).toEqual([])
})
