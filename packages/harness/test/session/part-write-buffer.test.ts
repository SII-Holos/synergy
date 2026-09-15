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
  test("transaction admission requires buffered, running and failed writes to drain first", async () => {
    let fail = true
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const buffer = new PartWriteBuffer<string>(async () => {
      await blocked
      if (fail) throw new Error("transient")
    }, 10_000)
    expect(() => buffer.assertDrained("part")).not.toThrow()
    buffer.defer("part", "part", "stream")
    expect(() => buffer.assertDrained("part")).toThrow("Drain")
    const pending = buffer.flush("part")
    expect(() => buffer.assertDrained("part")).toThrow("Drain")
    release()
    await expect(pending).rejects.toThrow("transient")
    expect(() => buffer.assertDrained("part")).toThrow("Drain")
    fail = false
    await buffer.flushAll()
    expect(() => buffer.assertDrained("part")).not.toThrow()
  })

  test("terminal writes wait for an already executing streaming write", async () => {
    const writes: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const buffer = new PartWriteBuffer<string>(async (_path, value) => {
      if (value === "stream") await blocked
      writes.push(value)
    }, 1)
    buffer.defer("part", "part", "stream")
    await Bun.sleep(10)
    const terminal = buffer.writeNow("part", "part", "complete")
    expect(writes).toEqual([])
    release()
    await terminal
    await buffer.flushAll()
    expect(writes).toEqual(["stream", "complete"])
  })

  test("draining includes timer writes and reports background persistence failure", async () => {
    const buffer = new PartWriteBuffer<string>(async () => {
      throw new Error("disk full")
    }, 1)
    buffer.defer("part", "part", "stream")
    await Bun.sleep(10)
    await expect(buffer.flushAll()).rejects.toThrow("disk full")
  })

  test("a later successful write clears the retained failure for the same key", async () => {
    let fail = true
    const writes: string[] = []
    const buffer = new PartWriteBuffer<string>(async (_path, value) => {
      if (fail) throw new Error("transient")
      writes.push(value)
    }, 10_000)
    buffer.defer("part", "part", "stream")
    await expect(buffer.flush("part")).rejects.toThrow("transient")
    fail = false
    await buffer.writeNow("part", "part", "complete")
    expect(writes).toEqual(["complete"])
    await buffer.flushAll()
    expect(writes).toEqual(["complete"])
  })

  test("a transient part failure does not block later drains of the same session", async () => {
    let fail = true
    const buffer = new PartWriteBuffer<{ sessionID: string; text: string }>(async (_path, value) => {
      if (fail) throw new Error("transient")
    }, 10_000)
    buffer.defer("p1", "path/p1", { sessionID: "ses_1", text: "one" })
    await expect(buffer.flushWhere((value) => value.sessionID === "ses_1")).rejects.toThrow("transient")
    fail = false
    buffer.defer("p2", "path/p2", { sessionID: "ses_1", text: "two" })
    await buffer.flushWhere((value) => value.sessionID === "ses_1")
  })
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
