import { expect, test } from "bun:test"
import { createPartMaterializer } from "../../src/context/part-materializer"
import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

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
    apply: (part) => applied.push(part),
    evict: () => {},
  })
  const old = materializer.retain(summary("a"))
  const current = materializer.retain(summary("a", "two"))
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
