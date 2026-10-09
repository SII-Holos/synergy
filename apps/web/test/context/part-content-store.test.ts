import { describe, expect, test } from "bun:test"
import type { Part } from "@ericsanchezok/synergy-sdk"
import { createPartContentStore } from "../../src/context/part-content-store"

const part = (id: string): Part => ({ id, sessionID: "ses_a", messageID: "msg_a", type: "text", text: id }) as Part

describe("createPartContentStore.readThrough", () => {
  test("concurrent reads for one version share a single physical fetch, sequential hits use the cache", async () => {
    const store = createPartContentStore()
    let fetches = 0
    const read = () =>
      store.readThrough({
        url: "http://t",
        scopeKey: "scope",
        partID: "p1",
        version: "v1",
        bytes: 12,
        read: async () => {
          fetches++
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { part: part("p1"), version: "v1" }
        },
      })
    const [a, b] = await Promise.all([read(), read()])
    // Two concurrent callers shared one in-flight network read.
    expect(fetches).toBe(1)
    expect(a.part).toMatchObject({ text: "p1" })
    expect(b).toBe(a)
    // After settle, another caller hits the version-keyed cache — still one fetch.
    const c = await read()
    expect(fetches).toBe(1)
    expect(c.part).toMatchObject({ text: "p1" })
  })

  test("a failed read does not poison retries and inflight entries are cleaned up", async () => {
    const store = createPartContentStore()
    let attempts = 0
    const tryRead = () =>
      store.readThrough({
        url: "http://t",
        scopeKey: "scope",
        partID: "p1",
        version: "v1",
        bytes: 12,
        read: async () => {
          attempts++
          if (attempts === 1) throw new Error("transient")
          return { part: part("p1"), version: "v1" }
        },
      })
    await expect(tryRead()).rejects.toThrow("transient")
    // The rejection was not cached and the inflight entry was removed, so a
    // retry issues exactly one new physical read and then caches the result.
    const ok = await tryRead()
    expect(attempts).toBe(2)
    expect(ok.part).toMatchObject({ text: "p1" })
    const again = await tryRead()
    expect(attempts).toBe(2)
    expect(again.part).toMatchObject({ text: "p1" })
  })
})
