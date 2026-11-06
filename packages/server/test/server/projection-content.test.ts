import { expect, test } from "bun:test"
import { createProjectionContent } from "../../src/server/projection-content"

test("content checkpoints are immutable, Scope fenced, explicitly released and memory bounded", async () => {
  const cache = createProjectionContent(30)
  const identity = { scopeID: "scope", sessionID: "session", messageID: "message", partID: "part" }
  const part = { type: "text" as const, id: "part", messageID: "message", sessionID: "session", text: "before" }
  const first = cache.retain(identity, part, { version: "one", bytes: 10 })
  part.text = "after"
  expect((await cache.read(identity, first.token)).part).toMatchObject({ text: "before" })
  await expect(cache.read({ ...identity, scopeID: "other" }, first.token)).rejects.toThrow()
  const second = cache.retain(identity, part, { version: "two", bytes: 10 })
  await expect(cache.read(identity, first.token)).rejects.toThrow()
  expect(cache.bytes).toBe(20)
  expect(cache.size).toBe(1)
  second.release()
  second.release()
  expect(cache.bytes).toBe(0)
})

test("a single body larger than the memory budget remains readable without retaining its body in memory", async () => {
  const cache = createProjectionContent(16)
  const identity = { scopeID: "scope", sessionID: "session", messageID: "message", partID: "part" }
  const part = { type: "text" as const, id: "part", messageID: "message", sessionID: "session", text: "original body" }
  const retained = cache.retain(identity, part, { version: "large", bytes: 100 })
  part.text = "later body"
  try {
    expect((await cache.read(identity, retained.token)).part).toMatchObject({ text: "original body" })
    expect(cache.bytes).toBeLessThanOrEqual(16)
    expect(cache.size).toBe(1)
  } finally {
    retained.release()
  }
  expect(cache.size).toBe(0)
  await expect(cache.read(identity, retained.token)).rejects.toThrow()
})

test("oversized checkpoint handles are bounded and release safely during concurrent reads", async () => {
  const cache = createProjectionContent(8)
  const identity = { scopeID: "scope", sessionID: "session", messageID: "message", partID: "part" }
  const part = { ...identity, id: "part", type: "text" as const, text: "large fixture body" }
  const leases = Array.from({ length: 20 }, () => cache.retain(identity, part, { version: "v", bytes: 100 }))
  try {
    expect(cache.size).toBe(16)
    await expect(cache.read(identity, leases[0]!.token)).rejects.toThrow()
    const last = leases.at(-1)!
    const reads = [cache.read(identity, last.token), cache.read(identity, last.token)]
    last.release()
    expect((await Promise.all(reads)).map((item) => item.part)).toEqual([part, part])
  } finally {
    for (const lease of leases) lease.release()
  }
  expect(cache.size).toBe(0)
  expect(cache.bytes).toBe(0)
})
