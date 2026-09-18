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
  test("rejects a new key once the 1024-entry cap is reached", () => {
    const r = recorder()
    const buf = new PartWriteBuffer<string>(r.write, 10_000)
    for (let index = 0; index < 1024; index++) buf.defer(`p${index}`, `path/p${index}`, "v")
    expect(() => buf.defer("overflow", "path/overflow", "v")).toThrow(
      "Streaming persistence buffer is full; drain before accepting more output",
    )
    // An already buffered key is replaced in place and consumes no new slot.
    expect(() => buf.defer("p0", "path/p0", "v2", "")).not.toThrow()
  })

  test("rejects appended growth that would exceed the 64 MiB deferred-byte budget", () => {
    const r = recorder()
    const buf = new PartWriteBuffer<{ text: string }>(r.write, 10_000)
    const part = { text: "" }
    const chunk = "x".repeat(8 * 1024 * 1024)
    buf.defer("p", "path/p", part)
    for (let index = 0; index < 7; index++) {
      part.text += chunk
      buf.defer("p", "path/p", part, chunk)
    }
    // The eighth chunk prices at 64 MiB + the initial measurement.
    part.text += chunk
    expect(() => buf.defer("p", "path/p", part, chunk)).toThrow(
      "Streaming persistence buffer is full; drain before accepting more output",
    )
  })

  test("incremental defers persist the final accumulated state, not the caller's later mutation", async () => {
    const r = recorder()
    const buf = new PartWriteBuffer<{ type: "text"; text: string }>(r.write, 10_000)
    const part = { type: "text" as const, text: "" }
    part.text += "hello"
    buf.defer("p", "path/p", part, "hello")
    part.text += " world"
    buf.defer("p", "path/p", part, " world")
    await buf.flush("p")
    expect(r.writes).toEqual([{ path: "path/p", value: { type: "text", text: "hello world" } }])
    part.text = "mutated after the flush"
    expect(r.writes).toEqual([{ path: "path/p", value: { type: "text", text: "hello world" } }])
    expect(() => buf.assertDrained("p")).not.toThrow()
  })

  test("a mutation while the write is in flight cannot change what was persisted", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const persisted: Array<{ text: string }> = []
    const buf = new PartWriteBuffer<{ text: string }>(async (_path, value) => {
      await blocked
      persisted.push(value)
    }, 10_000)
    const part = { text: "streamed" }
    buf.defer("p", "path/p", part, "streamed")
    const pending = buf.flush("p")
    part.text = "mutated during the write"
    release()
    await pending
    expect(persisted).toEqual([{ text: "streamed" }])
  })

  test("flush rejects when the exact snapshot exceeds the buffer budget the caller under-reported", async () => {
    const writes: unknown[] = []
    const buf = new PartWriteBuffer<{ text: string; extra?: string }>((_path, value) => {
      writes.push(value)
    }, 10_000)
    const part: { text: string; extra?: string } = { text: "x".repeat(34 * 1024 * 1024) }
    buf.defer("p", "path/p", part)
    part.text += "z"
    buf.defer("p", "path/p", part, "z")
    // Growth the appended-text accounting cannot see: the buffered estimate
    // stays inside the budget while the exact snapshot does not.
    part.extra = "y".repeat(31 * 1024 * 1024)
    await expect(buf.flush("p")).rejects.toThrow("Streaming persistence buffer is full")
    expect(writes).toEqual([])
  })
})
