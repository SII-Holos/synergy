import { describe, expect, test } from "bun:test"
import { PartWriteBuffer } from "../../src/session/part-write-buffer"

function recorder() {
  const writes: Array<{ path: string; value: unknown }> = []
  return {
    writes,
    write: (path: string, value: unknown) => {
      writes.push({ path, value })
    },
  }
}

describe("PartWriteBuffer", () => {
  test("coalesces deferred writes: many defers, one flush writes the latest", () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 10_000)
    buf.defer("p1", "path/p1", "a")
    buf.defer("p1", "path/p1", "ab")
    buf.defer("p1", "path/p1", "abc")
    expect(r.writes).toEqual([]) // nothing written yet (timer not fired)
    buf.flush("p1")
    expect(r.writes).toEqual([{ path: "path/p1", value: "abc" }])
  })

  test("cancel drops a pending deferred write without persisting it", () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 10_000)
    buf.defer("p1", "path/p1", "streaming...")
    buf.cancel("p1")
    // caller persists the superseding value itself; the buffer must stay quiet
    buf.flush("p1")
    expect(r.writes).toEqual([])
  })

  test("independent keys don't interfere", async () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 10_000)
    buf.defer("p1", "path/p1", "one")
    buf.defer("p2", "path/p2", "two")
    await buf.flushAll()
    expect(r.writes).toContainEqual({ path: "path/p1", value: "one" })
    expect(r.writes).toContainEqual({ path: "path/p2", value: "two" })
    expect(r.writes).toHaveLength(2)
  })

  test("flushAll awaits async writes (durability before finalize)", async () => {
    const order: string[] = []
    const buf = new PartWriteBuffer<string>(async (path, value) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${path}=${value}`)
    }, 10_000)
    buf.defer("p1", "path/p1", "final")
    await buf.flushAll()
    // the async write completed before flushAll resolved
    expect(order).toEqual(["path/p1=final"])
  })

  test("flushWhere only persists matching deferred writes", async () => {
    const r = recorder()
    const buf = new PartWriteBuffer<{ sessionID: string; text: string }>(r.write, 10_000)
    buf.defer("p1", "path/p1", { sessionID: "ses_1", text: "one" })
    buf.defer("p2", "path/p2", { sessionID: "ses_2", text: "two" })

    await buf.flushWhere((value) => value.sessionID === "ses_1")

    expect(r.writes).toEqual([{ path: "path/p1", value: { sessionID: "ses_1", text: "one" } }])
    await buf.flushAll()
    expect(r.writes).toContainEqual({ path: "path/p2", value: { sessionID: "ses_2", text: "two" } })
  })

  test("the timer flushes without an explicit flush call", async () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 5)
    buf.defer("p1", "path/p1", "v1")
    buf.defer("p1", "path/p1", "v2")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(r.writes).toEqual([{ path: "path/p1", value: "v2" }])
  })

  test("flush on an empty key is a no-op", () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 10_000)
    buf.flush("missing")
    expect(r.writes).toEqual([])
  })
})
