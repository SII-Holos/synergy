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

  for (const transport of ["broadcast", "heartbeat", "reply"] as const) {
    for (const failure of ["dropped", "error"] as const) {
      test(`${transport} closes an open socket after send result ${failure}`, () => {
        const closed: number[] = []
        const removedDuringClose: boolean[] = []
        const registry = GlobalEventClients.createRegistry()
        const raw = {
          readyState: 1,
          send: () => {
            if (failure === "error") throw new Error("transport failure")
            return 0
          },
        }
        const ws = fakeWs({
          raw,
          close: (code) => {
            closed.push(code!)
            removedDuringClose.push(registry.remove(fakeWs({ raw })))
          },
        })
        registry.add(ws, "delta")

        if (transport === "reply") registry.reply(fakeWs({ raw }), "pong")
        else if (transport === "heartbeat") registry.heartbeat("heartbeat")
        else registry.broadcast(() => "idle")

        expect(registry.size()).toBe(0)
        expect(closed).toEqual([1013])
        expect(removedDuringClose).toEqual([false])
        const received: string[] = []
        registry.add(fakeWs({ raw: { readyState: 1, send: (data) => received.push(data) } }), "delta")
        registry.broadcast(() => "idle")
        expect(received).toEqual(["idle"])
      })
    }
  }

  test("an unregistered socket cannot receive a pong that masks lost events", () => {
    const registry = GlobalEventClients.createRegistry()
    const received: string[] = []
    const closed: number[] = []
    const ws = fakeWs({
      raw: { readyState: 1, send: (data) => received.push(data) },
      close: (code) => closed.push(code!),
    })

    expect(registry.reply(ws, "pong")).toBe("closed")
    expect(received).toEqual([])
    expect(closed).toEqual([1013])
  })

  test("control frames do not evict a subscribed client under transient backpressure", () => {
    const closed: number[] = []
    const registry = GlobalEventClients.createRegistry({ maxConsecutiveBackpressure: 1 })
    const raw = { readyState: 1, send: () => -1 }
    const ws = fakeWs({ raw, close: (code) => closed.push(code!) })
    registry.add(ws, "delta")

    registry.heartbeat("heartbeat")
    expect(registry.reply(fakeWs({ raw }), "pong")).toBe("backpressured")
    expect(registry.size()).toBe(1)
    expect(closed).toEqual([])
    expect([...registry.clients()][0].consecutiveBackpressure).toBe(0)
  })

  test("explicit removal closes the registered socket across fresh wrappers", () => {
    const closed: number[] = []
    const registry = GlobalEventClients.createRegistry()
    const raw = { readyState: 1, send: () => 1 }
    registry.add(fakeWs({ raw, close: (code) => closed.push(code!) }), "delta")

    expect(registry.remove(fakeWs({ raw }))).toBe(true)
    expect(registry.remove(fakeWs({ raw }))).toBe(false)
    expect(closed).toEqual([1013])
  })

  test("a failing close does not retain a dead subscription or block healthy clients", () => {
    const registry = GlobalEventClients.createRegistry()
    registry.add(
      fakeWs({
        raw: { readyState: 1, send: () => 0 },
        close: () => {
          throw new Error("close failed")
        },
      }),
      "delta",
    )
    const received: string[] = []
    registry.add(fakeWs({ raw: { readyState: 1, send: (data) => received.push(data) } }), "delta")

    expect(registry.broadcast(() => "idle")).toEqual({ clients: 2, sent: 1, dropped: 1, removed: 1 })
    expect(received).toEqual(["idle"])
    expect(registry.size()).toBe(1)
  })

  test("clearing the registry closes remaining subscriptions", () => {
    const registry = GlobalEventClients.createRegistry()
    const closed: number[] = []
    registry.add(fakeWs({ raw: { readyState: 1 }, close: (code) => closed.push(code!) }), "delta")

    registry.clear()
    expect(registry.size()).toBe(0)
    expect(closed).toEqual([1013])
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
