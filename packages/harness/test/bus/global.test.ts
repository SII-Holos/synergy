import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("bus.GlobalBus", () => {
  const listeners: Array<() => void> = []

  afterEach(() =>
    runtime.run(() => {
      for (const off of listeners) off()
      listeners.length = 0
    }),
  )

  test("emits and receives event payloads", () =>
    runtime.run(() => {
      const received: Array<{ scopeID: string | null; payload: any }> = []
      const handler = (data: { scopeID: string | null; payload: any }) => {
        received.push(data)
      }
      GlobalBus().on("event", handler)
      listeners.push(() => GlobalBus().off("event", handler))

      GlobalBus().emit("event", { scopeID: null, payload: { type: "test", properties: {} } })

      expect(received).toHaveLength(1)
      expect(received[0].payload).toEqual({ type: "test", properties: {} })
      expect(received[0].scopeID).toBeNull()
    }))

  test("delivers the stable Scope ID", () =>
    runtime.run(() => {
      const received: Array<{ scopeID: string | null; payload: any }> = []
      const handler = (data: { scopeID: string | null; payload: any }) => {
        received.push(data)
      }
      GlobalBus().on("event", handler)
      listeners.push(() => GlobalBus().off("event", handler))

      GlobalBus().emit("event", { scopeID: "d_project", payload: { type: "disposed" } })

      expect(received).toHaveLength(1)
      expect(received[0].scopeID).toBe("d_project")
      expect(received[0].payload).toEqual({ type: "disposed" })
    }))

  test("supports multiple listeners", () =>
    runtime.run(() => {
      const results1: any[] = []
      const results2: any[] = []

      const handler1 = (data: any) => results1.push(data)
      const handler2 = (data: any) => results2.push(data)

      GlobalBus().on("event", handler1)
      GlobalBus().on("event", handler2)
      listeners.push(() => GlobalBus().off("event", handler1))
      listeners.push(() => GlobalBus().off("event", handler2))

      GlobalBus().emit("event", { scopeID: null, payload: "hello" })

      expect(results1).toHaveLength(1)
      expect(results2).toHaveLength(1)
      expect(results1[0].payload).toBe("hello")
      expect(results2[0].payload).toBe("hello")
    }))

  test("removeListener stops delivery", () =>
    runtime.run(() => {
      const received: any[] = []
      const handler = (data: any) => received.push(data)

      GlobalBus().on("event", handler)
      GlobalBus().emit("event", { scopeID: null, payload: "first" })
      expect(received).toHaveLength(1)

      GlobalBus().removeListener("event", handler)
      GlobalBus().emit("event", { scopeID: null, payload: "second" })
      expect(received).toHaveLength(1)
      expect(received[0].payload).toBe("first")
    }))

  test("off stops delivery (alias for removeListener)", () =>
    runtime.run(() => {
      const received: any[] = []
      const handler = (data: any) => received.push(data)

      GlobalBus().on("event", handler)
      GlobalBus().emit("event", { scopeID: null, payload: "a" })
      expect(received).toHaveLength(1)

      GlobalBus().off("event", handler)
      GlobalBus().emit("event", { scopeID: null, payload: "b" })
      expect(received).toHaveLength(1)
    }))
})

afterRuntimeTests(() => runtime.close())
