import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"

describe("bus.GlobalBus", () => {
  const listeners: Array<() => void> = []

  afterEach(() => {
    for (const off of listeners) off()
    listeners.length = 0
  })

  test("emits and receives event payloads", () => {
    const received: Array<{ directory?: string; payload: any }> = []
    const handler = (data: { directory?: string; payload: any }) => {
      received.push(data)
    }
    GlobalBus.on("event", handler)
    listeners.push(() => GlobalBus.off("event", handler))

    GlobalBus.emit("event", { payload: { type: "test", properties: {} } })

    expect(received).toHaveLength(1)
    expect(received[0].payload).toEqual({ type: "test", properties: {} })
    expect(received[0].directory).toBeUndefined()
  })

  test("delivers directory field when provided", () => {
    const received: Array<{ directory?: string; payload: any }> = []
    const handler = (data: { directory?: string; payload: any }) => {
      received.push(data)
    }
    GlobalBus.on("event", handler)
    listeners.push(() => GlobalBus.off("event", handler))

    GlobalBus.emit("event", { directory: "/tmp/project", payload: { type: "disposed" } })

    expect(received).toHaveLength(1)
    expect(received[0].directory).toBe("/tmp/project")
    expect(received[0].payload).toEqual({ type: "disposed" })
  })

  test("supports multiple listeners", () => {
    const results1: any[] = []
    const results2: any[] = []

    const handler1 = (data: any) => results1.push(data)
    const handler2 = (data: any) => results2.push(data)

    GlobalBus.on("event", handler1)
    GlobalBus.on("event", handler2)
    listeners.push(() => GlobalBus.off("event", handler1))
    listeners.push(() => GlobalBus.off("event", handler2))

    GlobalBus.emit("event", { payload: "hello" })

    expect(results1).toHaveLength(1)
    expect(results2).toHaveLength(1)
    expect(results1[0].payload).toBe("hello")
    expect(results2[0].payload).toBe("hello")
  })

  test("removeListener stops delivery", () => {
    const received: any[] = []
    const handler = (data: any) => received.push(data)

    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: "first" })
    expect(received).toHaveLength(1)

    GlobalBus.removeListener("event", handler)
    GlobalBus.emit("event", { payload: "second" })
    expect(received).toHaveLength(1)
    expect(received[0].payload).toBe("first")
  })

  test("off stops delivery (alias for removeListener)", () => {
    const received: any[] = []
    const handler = (data: any) => received.push(data)

    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: "a" })
    expect(received).toHaveLength(1)

    GlobalBus.off("event", handler)
    GlobalBus.emit("event", { payload: "b" })
    expect(received).toHaveLength(1)
  })
})
