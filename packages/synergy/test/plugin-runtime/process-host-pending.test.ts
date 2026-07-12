import { describe, expect, test } from "bun:test"
import { createPendingRequestMap } from "../../src/plugin-runtime/process-host"

describe("createPendingRequestMap", () => {
  test("resolves a tracked request once", async () => {
    const pending = createPendingRequestMap()
    const result = pending.track("req-1")
    expect(pending.resolve("req-1", { generation: "g1", value: { ok: true } })).toBe(true)
    await expect(result).resolves.toEqual({ generation: "g1", value: { ok: true } })
    expect(pending.size()).toBe(0)
  })

  test("rejects a tracked request and ignores a late resolve", async () => {
    const pending = createPendingRequestMap()
    const result = pending.track("req-2")
    const cancelError = Object.assign(new Error("Plugin invocation cancelled"), { code: "CANCELLED" })

    expect(pending.reject("req-2", cancelError)).toBe(true)
    expect(pending.resolve("req-2", { generation: "g1", value: "late" })).toBe(false)
    expect(pending.reject("req-2", new Error("again"))).toBe(false)

    await expect(result).rejects.toBe(cancelError)
    expect(pending.size()).toBe(0)
  })

  test("rejectAll settles every pending request once", async () => {
    const pending = createPendingRequestMap()
    const first = pending.track("a")
    const second = pending.track("b")
    const exitError = new Error("Plugin runtime exited")

    pending.rejectAll(exitError)
    pending.rejectAll(new Error("duplicate exit"))

    await expect(first).rejects.toBe(exitError)
    await expect(second).rejects.toBe(exitError)
    expect(pending.size()).toBe(0)
  })
})
