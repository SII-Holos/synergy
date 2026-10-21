import { describe, expect, test } from "bun:test"
import { PartWriteBuffer } from "../../src/session/part-write-buffer"
import type { PartContent } from "../../src/session/part-content"
import type { MessageV2 } from "../../src/session/message-v2"

const part = (text: string, id = "part", sessionID = "session"): MessageV2.TextPart => ({
  id,
  messageID: "message",
  sessionID,
  type: "text",
  text,
})
const path = ["sessions", "home", "session", "messages", "message", "parts", "part"]

describe("PartWriteBuffer", () => {
  test("coalesces immutable pending deltas, captures a nonempty initial prefix and forgets flushed text", async () => {
    const writes: PartContent.Batch[] = []
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      writes.push(batch)
    }, 10_000)
    const value = part("prefix one")
    buffer.defer(value.id, path, value, "one")
    value.text += " two"
    buffer.defer(value.id, path, value, " two")
    expect(() => buffer.assertDrained(value.id)).toThrow("Drain")
    await buffer.flushAll()
    expect(writes.map((batch) => [batch.offset, batch.text])).toEqual([[0, "prefix one two"]])
    value.text += " three"
    buffer.defer(value.id, path, value, " three")
    await buffer.flushAll()
    expect(writes.map((batch) => [batch.offset, batch.text])).toEqual([
      [0, "prefix one two"],
      [14, " three"],
    ])
    value.text = "unreported caller mutation"
    expect(writes[1]!.text).toBe(" three")
    expect(() => buffer.assertDrained(value.id)).not.toThrow()
  })

  test.each([false, true])("new output behind a held write preserves content with replacement=%s", async (replace) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      entered.resolve()
      if (!batch.offset) await release.promise
      writes.push(batch.text)
    }, 10_000)
    const value = part("first")
    buffer.defer(value.id, path, value, value.text)
    const running = buffer.flush(value.id)
    await entered.promise
    value.text += " second"
    buffer.defer(value.id, path, value, " second")
    const terminal = replace
      ? buffer.writeNow(value.id, path, { ...value, text: value.text + " completed" }, async (_path, next) => {
          if (next.type === "text") writes.push(next.text)
        })
      : buffer.flushAll()
    expect(writes).toEqual([])
    release.resolve()
    await Promise.all([running, terminal])
    expect(writes).toEqual(replace ? ["first", "first second completed"] : ["first", " second"])
    expect(() => buffer.assertDrained(value.id)).not.toThrow()
  })

  test("retains failed immutable batch identity and retries it before newer deltas", async () => {
    let failing = true
    const attempts: PartContent.Batch[] = []
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      attempts.push(batch)
      if (failing) throw new Error("unavailable")
    }, 10_000)
    const value = part("first")
    buffer.defer(value.id, path, value, value.text)
    await expect(buffer.flushAll()).rejects.toThrow("unavailable")
    expect(() => buffer.assertDrained(value.id)).toThrow("Drain")
    value.text += " later"
    buffer.defer(value.id, path, value, " later")
    failing = false
    await buffer.flushAll()
    expect(attempts.map((batch) => batch.text)).toEqual(["first", "first", " later"])
    expect(attempts[0]).toBe(attempts[1]!)
    expect(attempts[1]!.operationID).not.toBe(attempts[2]!.operationID)
    expect(() => buffer.assertDrained(value.id)).not.toThrow()
  })

  test("cancellation fences a held write and discards pending output without retry resurrection", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    const buffer = new PartWriteBuffer(async (_path, batch, guard) => {
      entered.resolve()
      await release.promise
      guard()
      writes.push(batch.text)
    }, 10_000)
    const value = part("first")
    buffer.defer(value.id, path, value, value.text)
    const running = buffer.flush(value.id)
    await entered.promise
    value.text += " later"
    buffer.defer(value.id, path, value, " later")
    buffer.cancel(value.id)
    release.resolve()
    await expect(running).rejects.toThrow("cancelled")
    await buffer.flushAll()
    expect(writes).toEqual([])
  })

  test("timed writes retain failures for drain and matching Sessions drain independently", async () => {
    const completed = Promise.withResolvers<void>()
    const writes: string[] = []
    let failing = true
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      completed.resolve()
      if (failing) throw new Error("disk full")
      writes.push(batch.header.id)
    }, 1)
    buffer.defer("one", path, part("one", "one"), "one")
    await completed.promise
    await expect(buffer.flushAll()).rejects.toThrow("disk full")
    failing = false
    buffer.defer("two", path, part("two", "two", "foreign"), "two")
    await buffer.flushWhere((header) => header.sessionID === "session")
    expect(writes).toEqual(["one"])
    await buffer.flushAll()
    expect(writes).toEqual(["one", "two"])
  })

  test("a Session drain never waits for another Session's already running write", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      if (batch.header.sessionID === "foreign") {
        entered.resolve()
        await release.promise
      }
    }, 10_000)
    buffer.defer("foreign", path, part("foreign", "foreign", "foreign"), "foreign")
    const running = buffer.flush("foreign")
    await entered.promise
    buffer.defer("own", path, part("own", "own"), "own")
    try {
      expect(
        await Promise.race([
          buffer.flushWhere((header) => header.sessionID === "session").then(() => "own drained"),
          Bun.sleep(500).then(() => "waited for foreign"),
        ]),
      ).toBe("own drained")
    } finally {
      release.resolve()
      await running
      await buffer.flushAll()
    }
  })

  test("failed terminal replacements retain an immutable retry until their owner drains", async () => {
    let failing = true
    const writes: MessageV2.Part[] = []
    const buffer = new PartWriteBuffer(async () => {}, 10_000)
    const value = part("terminal")
    await expect(
      buffer.writeNow(value.id, path, value, async (_path, snapshot) => {
        if (failing) throw new Error("terminal disk failure")
        writes.push(snapshot)
      }),
    ).rejects.toThrow("terminal disk failure")
    expect(() => buffer.assertDrained(value.id)).toThrow("Drain")
    value.text = "caller mutated after failure"
    failing = false
    await buffer.flushWhere((header) => header.sessionID === value.sessionID)
    expect(writes).toEqual([part("terminal")])
    expect(() => buffer.assertDrained(value.id)).not.toThrow()
  })

  test("a complete replacement supersedes an append failure without requiring the failed append to succeed", async () => {
    const writes: MessageV2.Part[] = []
    const buffer = new PartWriteBuffer(async () => {
      throw new Error("append unavailable")
    }, 10_000)
    const value = part("complete prefix")
    buffer.defer(value.id, path, value, value.text)
    await expect(buffer.flushAll()).rejects.toThrow("append unavailable")
    await buffer.writeNow(value.id, path, value, async (_path, snapshot) => {
      writes.push(snapshot)
    })
    expect(writes).toEqual([value])
    expect(() => buffer.assertDrained(value.id)).not.toThrow()
  })

  test("terminal failures keep their charged bytes and concurrent drains retry each immutable replacement once", async () => {
    let failing = true
    const snapshots: MessageV2.Part[] = []
    const buffer = new PartWriteBuffer(async () => {}, 10_000)
    const text = "x".repeat(8 * 1024 * 1024 - 1024)
    for (let index = 0; index < 8; index++) {
      await expect(
        buffer.writeNow(String(index), path, part(text, String(index)), async (_path, snapshot) => {
          if (failing) throw new Error("retained disk failure")
          snapshots.push(snapshot)
        }),
      ).rejects.toThrow("retained disk failure")
    }
    expect(() => buffer.defer("overflow", path, part("y".repeat(8192), "overflow"), "")).toThrow("buffer is full")
    await expect(buffer.flushAll()).rejects.toBeInstanceOf(AggregateError)
    failing = false
    await Promise.all([buffer.flushAll(), buffer.flushAll()])
    expect(snapshots).toHaveLength(8)
    expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(8)
    buffer.defer("released", path, part("released", "released"), "released")
    await buffer.flushAll()
  })

  test("owner release discards drained stream metadata and keeps other owners' append state intact", async () => {
    const writes: string[] = []
    const buffer = new PartWriteBuffer(async (_path, batch) => {
      writes.push(batch.text)
    }, 10_000)
    const own = part("old")
    const foreign = part("foreign", "foreign", "foreign")
    buffer.defer(own.id, path, own, own.text)
    buffer.defer(foreign.id, path, foreign, foreign.text)
    await buffer.flushAll()
    buffer.cancelWhere((header) => header.sessionID === own.sessionID)
    const restarted = part("replacement")
    buffer.defer(restarted.id, path, restarted, "replacement")
    foreign.text += " appended"
    buffer.defer(foreign.id, path, foreign, " appended")
    await buffer.flushAll()
    expect(writes.sort()).toEqual(["old", "foreign", "replacement", " appended"].sort())
  })

  test("only pending deltas consume capacity, not the committed prefix", async () => {
    const buffer = new PartWriteBuffer(async () => {}, 10_000)
    const value = part("")
    const chunk = "x".repeat(4 * 1024 * 1024)
    for (let index = 0; index < 9; index++) {
      value.text += chunk
      buffer.defer(value.id, path, value, chunk)
      await buffer.flushAll()
    }
    expect(value.text.length).toBeGreaterThan(32 * 1024 * 1024)
    expect(() => buffer.defer("large", path, part("x".repeat(32 * 1024 * 1024), "large"), "")).toThrow("buffer is full")
    const pending = part("x".repeat(31 * 1024 * 1024), "pending")
    buffer.defer(pending.id, path, pending, "")
    expect(() => buffer.defer("overflow", path, part("x".repeat(2 * 1024 * 1024), "overflow"), "")).toThrow(
      "buffer is full",
    )
    await buffer.flushAll()
  })

  test("key admission rejects the 1025th resident stream and owner release admits a new stream", async () => {
    const buffer = new PartWriteBuffer(async () => {}, 10_000)
    for (let index = 0; index < 1024; index++) {
      const value = part("x", `key-${index}`)
      buffer.defer(value.id, path, value, "x")
    }
    expect(() => buffer.defer("overflow", path, part("x", "overflow"), "x")).toThrow("buffer is full")
    await buffer.flushAll()
    expect(() => buffer.defer("overflow", path, part("x", "overflow"), "x")).toThrow("buffer is full")
    buffer.cancel("key-0")
    buffer.defer("released", path, part("x", "released"), "x")
    await buffer.flushAll()
    buffer.cancelWhere(() => true)
  })
})
