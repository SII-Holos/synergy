import { describe, expect, test } from "bun:test"
import { createQueuedBrowserSender } from "./browser-ws"

describe("createQueuedBrowserSender", () => {
  test("queues messages until the socket opens", () => {
    const sent: string[] = []
    const socket = {
      readyState: 0,
      send: (data: string) => sent.push(data),
    }
    const sender = createQueuedBrowserSender(() => socket, { openState: 1 })

    sender.send({ type: "createTab", url: "www.google.com" })

    expect(sent).toEqual([])
    expect(sender.size()).toBe(1)

    socket.readyState = 1
    sender.flush()

    expect(sent.map((item) => JSON.parse(item))).toEqual([{ type: "createTab", url: "www.google.com" }])
    expect(sender.size()).toBe(0)
  })

  test("keeps the newest messages when the queue is full", () => {
    const sent: string[] = []
    const socket = {
      readyState: 0,
      send: (data: string) => sent.push(data),
    }
    const sender = createQueuedBrowserSender(() => socket, { openState: 1, maxPending: 2 })

    sender.send({ type: "first" })
    sender.send({ type: "second" })
    sender.send({ type: "third" })

    socket.readyState = 1
    sender.flush()

    expect(sent.map((item) => JSON.parse(item))).toEqual([{ type: "second" }, { type: "third" }])
  })
})
