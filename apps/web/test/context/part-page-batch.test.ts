import { describe, expect, test } from "bun:test"
import type { SessionPartPage } from "@ericsanchezok/synergy-sdk/client"
import { createPartPageBatchReader, isPlainPartPageQuery } from "../../src/context/part-page-batch"

const pageFor = (messageID: string): SessionPartPage => ({
  items: [
    {
      id: `prt_of_${messageID}`,
      sessionID: "session",
      messageID,
      type: "text",
      preview: messageID,
      content: { version: "v", bytes: 4 },
    },
  ],
  nextCursor: null,
  previousCursor: null,
  hasMore: false,
  hasEarlier: false,
})

describe("isPlainPartPageQuery", () => {
  test("only cursor/partID/older-free queries are plain", () => {
    expect(isPlainPartPageQuery({})).toBe(true)
    expect(isPlainPartPageQuery({ cursor: "c" })).toBe(false)
    expect(isPlainPartPageQuery({ partID: "prt_x" })).toBe(false)
    expect(isPlainPartPageQuery({ older: true })).toBe(false)
  })
})

describe("createPartPageBatchReader", () => {
  test("coalesces same-microtask reads into one batch request", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    const [a, b, c] = await Promise.all([
      read("session", "msg_a", controller.signal),
      read("session", "msg_b", controller.signal),
      read("session", "msg_c", controller.signal),
    ])
    expect(batches).toEqual([["msg_a", "msg_b", "msg_c"]])
    expect(a.items[0].messageID).toBe("msg_a")
    expect(b.items[0].messageID).toBe("msg_b")
    expect(c.items[0].messageID).toBe("msg_c")
  })

  test("dedicated reads across microtasks issue separate batches", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    const first = await read("session", "msg_a", controller.signal)
    const second = await read("session", "msg_b", controller.signal)
    expect(batches).toEqual([["msg_a"], ["msg_b"]])
    expect(first.items[0].messageID).toBe("msg_a")
    expect(second.items[0].messageID).toBe("msg_b")
  })

  test("a batch failure rejects every pending read without poisoning later batches", async () => {
    let calls = 0
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        calls += 1
        if (calls === 1) throw new Error("storage busy")
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    await expect(read("session", "msg_a", controller.signal)).rejects.toThrow("storage busy")
    const second = await read("session", "msg_b", controller.signal)
    expect(second.items[0].messageID).toBe("msg_b")
    expect(calls).toBe(2)
  })

  test("aborted reads are excluded from the batch and rejected", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const keep = new AbortController()
    const drop = new AbortController()
    const dropped = read("session", "msg_dropped", drop.signal)
    drop.abort()
    const kept = await Promise.all([
      read("session", "msg_kept", keep.signal),
      (async () => {
        try {
          await dropped
          return "resolved"
        } catch {
          return "aborted"
        }
      })(),
    ])
    expect(batches).toEqual([["msg_kept"]])
    expect(kept[0].items[0].messageID).toBe("msg_kept")
    expect(kept[1]).toBe("aborted")
  })
})
