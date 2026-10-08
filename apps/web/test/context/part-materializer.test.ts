import { expect, test } from "bun:test"
import { createPartMaterializer } from "../../src/context/part-materializer"
import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import { createContentBudget } from "../../src/context/content-budget"
import { PartSummarySupersededError } from "../../src/context/part-summary-loader"

const summary = (id: string, version = "one"): SessionPartSummary => ({
  id,
  sessionID: "session",
  messageID: "message",
  type: "text",
  preview: "preview",
  content: { version, bytes: 12 },
})
const body = (id: string): Part => ({ id, sessionID: "session", messageID: "message", type: "text", text: id })

test("visible consumers share a body and releasing one preserves its successor", async () => {
  let reads = 0
  let cancelled = false
  let resolve!: (value: { part: Part; version: string }) => void
  const applied: Part[] = []
  const materializer = createPartMaterializer({
    budget: 24,
    read: async (_, signal) => {
      reads++
      signal.addEventListener("abort", () => (cancelled = true))
      return new Promise((done) => (resolve = done))
    },
    apply: (part) => applied.push(part),
    evict: () => {},
  })
  const first = materializer.retain(summary("a"))
  const second = materializer.retain(summary("a"))
  first.release()
  expect(cancelled).toBe(false)
  resolve({ part: body("a"), version: "one" })
  await second.ready
  expect(reads).toBe(1)
  expect(applied.map((part) => part.id)).toEqual(["a"])
  second.release()
  materializer.dispose()
})

test("obsolete content cannot publish after its version changes", async () => {
  const completions: ((value: { part: Part; version: string }) => void)[] = []
  const applied: Part[] = []
  const materializer = createPartMaterializer({
    read: async () => new Promise((done) => completions.push(done)),
    wait: async () => {},
    apply: (part) => applied.push(part),
    evict: () => {},
  })
  const old = materializer.retain(summary("a"))
  const current = materializer.retain(summary("a", "two"))
  await new Promise((resolve) => setTimeout(resolve, 0))
  completions[0]({ part: body("old"), version: "one" })
  completions[1]({ part: body("new"), version: "two" })
  await Promise.all([old.ready, current.ready])
  expect(applied.map((part) => part.id)).toEqual(["new"])
  old.release()
  current.release()
  materializer.dispose()
})

test("the byte budget evicts inactive content before visible content", async () => {
  const evicted: string[] = []
  const materializer = createPartMaterializer({
    budget: 48,
    read: async (item) => ({ part: body(item.id), version: item.content.version }),
    apply: () => {},
    evict: (item) => evicted.push(item.id),
  })
  const a = materializer.retain(summary("a"))
  await a.ready
  const b = materializer.retain(summary("b"))
  await b.ready
  a.release()
  const c = materializer.retain(summary("c"))
  await c.ready
  expect(evicted).toEqual(["a"])
  expect(materializer.bytes).toBe(48)
  b.release()
  c.release()
  materializer.dispose()
})

const conflict = { name: "SessionDisplayConflict", data: { message: "Part content changed; refresh its summary" } }

test("shared consumers recover a structured version conflict without publishing the old body", async () => {
  const requested: string[] = []
  const applied: string[] = []
  const waits: number[] = []
  let refreshed = 0
  const materializer = createPartMaterializer({
    read: async (item) => {
      requested.push(item.content.version)
      if (item.content.version === "one") throw conflict
      return { part: body(item.id), version: item.content.version }
    },
    refresh: async (item) => {
      refreshed++
      return summary(item.id, "two")
    },
    wait: async (ms) => {
      waits.push(ms)
    },
    apply: (_, item) => {
      applied.push(item.content.version)
    },
    evict: () => {},
  })
  const first = materializer.retain(summary("a"))
  const second = materializer.retain(summary("a"))
  await Promise.all([first.ready, second.ready])
  expect(requested).toEqual(["one", "two"])
  expect(refreshed).toBe(1)
  expect(waits).toEqual([100])
  expect(applied).toEqual(["two"])
  first.release()
  second.release()
  materializer.dispose()
})

test("keeps the accepted body and its memory accounting until a newer version succeeds", async () => {
  const memory = createContentBudget(24)
  let finish!: (value: { part: Part; version: string }) => void
  const evicted: string[] = []
  const materializer = createPartMaterializer({
    memory,
    read: async (item) =>
      item.content.version === "one"
        ? { part: body(item.id), version: "one" }
        : new Promise((resolve) => {
            finish = resolve
          }),
    apply: () => {},
    evict: (item) => {
      evicted.push(item.content.version)
    },
  })
  const old = materializer.retain(summary("a"))
  await old.ready
  const next = materializer.retain(summary("a", "two"))
  old.release()
  expect(evicted).toEqual([])
  expect(memory.bytes).toBe(24)
  expect(materializer.bytes).toBe(24)
  finish({ part: body("a"), version: "two" })
  await next.ready
  expect(memory.bytes).toBe(24)
  next.release()
  materializer.dispose()
  expect(memory.bytes).toBe(0)
})

test("revalidation cancels obsolete work while retaining accepted content until the new summary succeeds", async () => {
  const memory = createContentBudget()
  const pending: Array<(value: { part: Part; version: string }) => void> = []
  const applied: string[] = []
  const evicted: string[] = []
  const signals: AbortSignal[] = []
  const materializer = createPartMaterializer({
    memory,
    read: async (item, signal) => {
      signals.push(signal)
      return item.content.version === "one"
        ? { part: body(item.id), version: "one" }
        : new Promise((resolve) => pending.push(resolve))
    },
    apply: (_, item) => applied.push(item.content.version),
    evict: (item) => evicted.push(item.content.version),
  })
  const accepted = materializer.retain(summary("a"))
  await accepted.ready
  const obsolete = materializer.retain(summary("a", "two"))
  materializer.revalidate("message")
  expect(signals[1].aborted).toBe(true)
  expect(evicted).toEqual([])
  expect(memory.bytes).toBe(24)
  expect(materializer.bytes).toBe(24)
  const current = materializer.retain(summary("a", "three"))
  pending[0]({ part: body("obsolete"), version: "two" })
  pending[1]({ part: body("current"), version: "three" })
  await Promise.all([obsolete.ready, current.ready])
  expect(applied).toEqual(["one", "three"])
  expect(memory.bytes).toBe(24)
  accepted.release()
  obsolete.release()
  current.release()
  materializer.dispose()
  expect(memory.bytes).toBe(0)
})

test("bounds conflicts across advancing versions, then allows a manual retry", async () => {
  let reads = 0
  let recover = false
  const waits: number[] = []
  const materializer = createPartMaterializer({
    read: async (item) => {
      reads++
      if (!recover) throw conflict
      return { part: body(item.id), version: item.content.version }
    },
    refresh: async (item) => summary(item.id, `version-${reads}`),
    wait: async (ms) => {
      waits.push(ms)
    },
    apply: () => {},
    evict: () => {},
  })
  const first = materializer.retain(summary("a"))
  await expect(first.ready).rejects.toMatchObject({ name: "PartContentSyncError" })
  expect(reads).toBe(8)
  expect(waits).toEqual([100, 200, 400, 800, 100, 200, 400])
  const advanced = materializer.retain(summary("a", "latest"))
  await expect(advanced.ready).rejects.toMatchObject({ name: "PartContentSyncError" })
  expect(reads).toBe(8)
  first.release()
  advanced.release()
  recover = true
  const retry = materializer.retain(summary("a", "latest"))
  await retry.ready
  expect(reads).toBe(9)
  retry.release()
  materializer.dispose()
})

test("a failed update preserves a readable body and uses only one attempt window", async () => {
  let reads = 0
  const evicted: string[] = []
  const materializer = createPartMaterializer({
    read: async (item) => {
      reads++
      if (item.content.version !== "one") throw conflict
      return { part: body(item.id), version: "one" }
    },
    refresh: async (item) => item,
    wait: async () => {},
    apply: () => {},
    evict: (item) => {
      evicted.push(item.content.version)
    },
  })
  const old = materializer.retain(summary("a"))
  await old.ready
  const next = materializer.retain(summary("a", "two"))
  old.release()
  await expect(next.ready).rejects.toMatchObject({ name: "PartContentSyncError" })
  expect(reads).toBe(5)
  expect(evicted).toEqual([])
  next.release()
  materializer.dispose()
})

test("real errors propagate without conflict refresh or automatic retries", async () => {
  for (const error of [
    new TypeError("Network unavailable"),
    { name: "PermissionDenied", data: { message: "Denied" } },
    { status: 409 },
  ]) {
    let reads = 0
    let refreshes = 0
    const materializer = createPartMaterializer({
      read: async () => {
        reads++
        throw error
      },
      refresh: async (item) => {
        refreshes++
        return item
      },
      apply: () => {},
      evict: () => {},
    })
    const lease = materializer.retain(summary("a"))
    await expect(lease.ready).rejects.toBe(error)
    expect(reads).toBe(1)
    expect(refreshes).toBe(0)
    lease.release()
    materializer.dispose()
  }
})

test("releasing the last reader cancels recovery and prevents late publication", async () => {
  let finish!: (value: SessionPartSummary) => void
  let signal!: AbortSignal
  let reads = 0
  let applied = 0
  const materializer = createPartMaterializer({
    read: async () => {
      reads++
      throw conflict
    },
    refresh: async (_, currentSignal) => {
      signal = currentSignal
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    wait: async () => {},
    apply: () => {
      applied++
    },
    evict: () => {},
  })
  const lease = materializer.retain(summary("a"))
  await new Promise((resolve) => setTimeout(resolve, 0))
  lease.release()
  expect(signal.aborted).toBe(true)
  await lease.ready
  finish(summary("a", "two"))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reads).toBe(1)
  expect(applied).toBe(0)
  materializer.dispose()
})

test("a superseded recovery page consumes the same bounded body recovery window", async () => {
  let refreshed = 0
  let reads = 0
  const materializer = createPartMaterializer({
    read: async (item) => {
      reads++
      if (item.content.version === "one") throw conflict
      return { part: body(item.id), version: item.content.version }
    },
    refresh: async (item) => {
      if (++refreshed === 1) throw new PartSummarySupersededError()
      return summary(item.id, "two")
    },
    wait: async () => {},
    apply: () => {},
    evict: () => {},
  })
  const lease = materializer.retain(summary("a"))
  await lease.ready
  expect(reads).toBe(3)
  lease.release()
  materializer.dispose()
})

test("part removal and scope disposal cancel pending reads even when the transport ignores abort", async () => {
  for (const cancel of ["remove", "dispose"] as const) {
    let finish!: (value: { part: Part; version: string }) => void
    let signal!: AbortSignal
    let applied = 0
    let subscribed = 0
    const materializer = createPartMaterializer({
      read: async (_, selected) => {
        signal = selected
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      subscribe: () => {
        subscribed++
        return () => {
          subscribed--
        }
      },
      apply: () => {
        applied++
      },
      evict: () => {},
    })
    const lease = materializer.retain(summary("a"))
    if (cancel === "remove") materializer.invalidate("message", "a")
    else materializer.dispose()
    expect(signal.aborted).toBe(true)
    await lease.ready
    finish({ part: body("a"), version: "one" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(applied).toBe(0)
    expect(subscribed).toBe(0)
    lease.release()
    expect(subscribed).toBe(0)
    materializer.dispose()
  }
})
