import { expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createCompletionNoticeClearer } from "../../../src/context/layout/completion-notice"

function fixture() {
  let server = "one"
  let notice = { unread: true, unreadCount: 2 }
  let ready = false
  let updates = 0
  let failures = 0
  let reject = false
  const clear = createCompletionNoticeClearer({
    server: () => server,
    read: () => notice,
    write: (_scope, _id, next) => {
      notice = next
      void clear("home", "history")
    },
    ready: async () => ready,
    update: async () => {
      updates++
      if (reject) throw new Error("unavailable")
    },
    failed: () => failures++,
  })
  return {
    clear,
    snapshot: () => ({ notice, updates, failures }),
    ready: () => (ready = true),
    reject: (value: boolean) => (reject = value),
    switchServer: () => (server = "two"),
  }
}

test("unprepared or quarantined history never receives a completion-notice mutation", async () => {
  const f = fixture()
  await f.clear("home", "history")
  expect(f.snapshot()).toEqual({ notice: { unread: true, unreadCount: 2 }, updates: 0, failures: 0 })
  f.ready()
  await f.clear("home", "history")
  expect(f.snapshot()).toEqual({ notice: { unread: false, unreadCount: 0 }, updates: 1, failures: 0 })
})

test("optimistic rollback cannot recursively retry a failed notice mutation", async () => {
  const f = fixture()
  f.ready()
  f.reject(true)
  await Promise.all([f.clear("home", "history"), f.clear("home", "history")])
  expect(f.snapshot()).toEqual({ notice: { unread: true, unreadCount: 2 }, updates: 1, failures: 1 })
  f.reject(false)
  await f.clear("home", "history")
  expect(f.snapshot()).toEqual({ notice: { unread: false, unreadCount: 0 }, updates: 2, failures: 1 })
})

test("a readiness response from the previous server cannot mutate the new server", async () => {
  const f = fixture()
  f.ready()
  const operation = f.clear("home", "history")
  f.switchServer()
  await operation
  expect(f.snapshot().updates).toBe(0)
  expect(f.snapshot().notice.unread).toBe(true)
})

test("a reactive layout keeps future unread subscriptions without a rollback request loop", async () => {
  let updates = 0
  const root = createRoot((dispose) => {
    const [notice, setNotice] = createSignal({ unread: true, unreadCount: 1 })
    const clear = createCompletionNoticeClearer({
      server: () => "one",
      read: notice,
      write: (_scope, _id, next) => setNotice(next),
      ready: async () => true,
      update: async () => {
        updates++
        if (updates < 10) throw new Error("unavailable")
      },
      failed: () => {},
    })
    createEffect(() => void clear("home", "history"))
    return { dispose, notice, setNotice }
  })
  try {
    await Bun.sleep(10)
    expect(updates).toBe(1)
    expect(root.notice().unread).toBe(true)
    root.setNotice({ unread: true, unreadCount: 2 })
    await Bun.sleep(10)
    expect(updates).toBe(2)
  } finally {
    root.dispose()
  }
})
