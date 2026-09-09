import { describe, expect, test } from "bun:test"
import { GlobalEventClients } from "../../src/server/global-event-clients"
import type { WSContext } from "hono/ws"

function fakeWs(input: {
  raw?: { readyState?: number; bufferedAmount?: number; send?: (data: string) => number | void }
  readyState?: number
  send?: (data: string) => void
  close?: (code?: number, reason?: string) => void
}): WSContext {
  return {
    raw: input.raw,
    readyState: input.readyState ?? input.raw?.readyState ?? 1,
    send: input.send ?? (() => {}),
    close: input.close ?? (() => {}),
    url: null,
    protocol: null,
    binaryType: "arraybuffer",
  } as unknown as WSContext
}

describe("GlobalEventClients", () => {
  test("keys clients by stable raw socket across fresh WSContext wrappers", () => {
    const registry = GlobalEventClients.createRegistry()
    const raw = { readyState: 1, send: () => 4 }
    const openWrapper = fakeWs({ raw })
    const closeWrapper = fakeWs({ raw })

    registry.add(openWrapper, "delta")
    expect(registry.size()).toBe(1)

    // Hono constructs a new WSContext per callback; identity must still match.
    expect(GlobalEventClients.connectionKey(openWrapper)).toBe(raw)
    expect(GlobalEventClients.connectionKey(closeWrapper)).toBe(raw)
    expect(registry.remove(closeWrapper)).toBe(true)
    expect(registry.size()).toBe(0)
  })

  test("falls back to the wrapper object when raw is unavailable", () => {
    const registry = GlobalEventClients.createRegistry()
    const wrapper = fakeWs({ readyState: 1 })
    registry.add(wrapper, "full")
    expect(registry.size()).toBe(1)
    expect(registry.remove(wrapper)).toBe(true)
    expect(registry.size()).toBe(0)
  })

  test("drops frames under backpressure and eventually evicts the client", () => {
    const closed: Array<{ code?: number; reason?: string }> = []
    const raw = {
      readyState: 1,
      bufferedAmount: 0,
      send: () => -1 as number,
    }
    const registry = GlobalEventClients.createRegistry({ maxConsecutiveBackpressure: 3 })
    registry.add(
      fakeWs({
        raw,
        close: (code, reason) => closed.push({ code, reason }),
      }),
      "delta",
    )

    const first = registry.broadcast(() => "frame")
    expect(first.sent).toBe(0)
    expect(first.dropped).toBe(1)
    expect(registry.size()).toBe(1)

    registry.broadcast(() => "frame")
    const third = registry.broadcast(() => "frame")
    expect(third.removed).toBe(1)
    expect(registry.size()).toBe(0)
    expect(closed).toEqual([{ code: 1013, reason: "websocket backpressure" }])
  })

  test("removes clients whose raw socket is no longer open", () => {
    const raw = {
      readyState: 3,
      send: () => {
        throw new Error("should not send on closed socket")
      },
    }
    const registry = GlobalEventClients.createRegistry()
    registry.add(fakeWs({ raw, readyState: 1 }), "full")
    const result = registry.broadcast(() => "payload")
    expect(result.removed).toBe(1)
    expect(registry.size()).toBe(0)
  })

  test("encodes full and delta payloads once per broadcast", () => {
    const registry = GlobalEventClients.createRegistry()
    const rawA = { readyState: 1, send: () => 1 }
    const rawB = { readyState: 1, send: () => 1 }
    registry.add(fakeWs({ raw: rawA }), "full")
    registry.add(fakeWs({ raw: rawB }), "delta")

    let fullEncodes = 0
    let deltaEncodes = 0
    registry.broadcast((mode) => {
      if (mode === "full") {
        fullEncodes++
        return "FULL"
      }
      deltaEncodes++
      return "DELTA"
    })

    expect(fullEncodes).toBe(1)
    expect(deltaEncodes).toBe(1)
  })
})
