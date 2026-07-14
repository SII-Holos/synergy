import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { DesktopRendererDelivery } from "../src/main-renderer-delivery.js"

class FrameFixture {
  destroyed = false
  detached = false
  failure: "disposed" | "payload" | null = null
  readonly messages: Array<{ channel: string; args: unknown[] }> = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.failure === "disposed") {
      this.destroyed = true
      throw new Error("frame unavailable")
    }
    if (this.failure === "payload") throw new Error("payload unavailable")
    this.messages.push({ channel, args })
  }
}

class WebContentsFixture extends EventEmitter {
  destroyed = false
  crashed = false
  frame = new FrameFixture()

  get mainFrame(): FrameFixture {
    return this.frame
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isCrashed(): boolean {
    return this.crashed
  }
}

function createFixture() {
  const contents = new WebContentsFixture()
  const delivery = new DesktopRendererDelivery(contents as unknown as WebContents)
  return { contents, delivery }
}

describe("Desktop renderer delivery", () => {
  test("delivers only after the current application renderer is ready", () => {
    const { contents, delivery } = createFixture()

    expect(delivery.send("desktop-window:event", { state: "early" })).toBe(false)
    expect(contents.frame.messages).toEqual([])

    expect(delivery.markReady()).toBe(true)
    expect(delivery.send("desktop-window:event", { state: "ready" })).toBe(true)
    expect(contents.frame.messages).toEqual([{ channel: "desktop-window:event", args: [{ state: "ready" }] }])
  })

  test("coalesces state snapshots and preserves one-shot messages until ready", () => {
    const { contents, delivery } = createFixture()

    expect(delivery.sendLatest("window-state", "desktop-window:event", { state: "first" })).toBe(false)
    expect(delivery.sendLatest("window-state", "desktop-window:event", { state: "latest" })).toBe(false)
    expect(delivery.enqueue("desktop.deepLink", "synergy://first")).toBe(false)
    expect(delivery.enqueue("desktop.deepLink", "synergy://second")).toBe(false)

    expect(delivery.markReady()).toBe(true)
    expect(contents.frame.messages).toEqual([
      { channel: "desktop-window:event", args: [{ state: "latest" }] },
      { channel: "desktop.deepLink", args: ["synergy://first"] },
      { channel: "desktop.deepLink", args: ["synergy://second"] },
    ])
  })

  test("invalidates readiness only when a main-frame document navigation starts", () => {
    const { contents, delivery } = createFixture()
    delivery.markReady()

    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
    expect(delivery.send("desktop-theme:event", "subframe")).toBe(true)

    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    expect(delivery.send("desktop-theme:event", "same-document")).toBe(true)

    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    expect(delivery.sendLatest("theme", "desktop-theme:event", "reload")).toBe(false)

    contents.frame = new FrameFixture()
    expect(delivery.markReady()).toBe(true)
    expect(delivery.send("desktop-theme:event", "reloaded")).toBe(true)
    expect(contents.frame.messages).toEqual([
      { channel: "desktop-theme:event", args: ["reload"] },
      { channel: "desktop-theme:event", args: ["reloaded"] },
    ])
  })

  test("does not target destroyed, crashed, detached, or failed renderer frames", () => {
    const { contents, delivery } = createFixture()
    delivery.markReady()

    contents.frame.detached = true
    expect(delivery.send("desktop-update:event", "detached")).toBe(false)
    expect(contents.frame.messages).toEqual([])

    contents.frame = new FrameFixture()
    contents.crashed = true
    expect(delivery.markReady()).toBe(false)
    contents.crashed = false

    contents.frame.destroyed = true
    expect(delivery.markReady()).toBe(false)
    contents.frame = new FrameFixture()
    contents.destroyed = true
    expect(delivery.markReady()).toBe(false)
    contents.destroyed = false

    contents.frame.failure = "disposed"
    expect(delivery.markReady()).toBe(true)
    expect(delivery.send("desktop-update:event", "failed")).toBe(false)
    contents.frame = new FrameFixture()
    expect(delivery.send("desktop-update:event", "still-blocked")).toBe(false)
  })

  test("preserves non-lifecycle send failures", () => {
    const { contents, delivery } = createFixture()
    delivery.markReady()
    contents.frame.failure = "payload"

    expect(() => delivery.send("desktop-update:event", Symbol("invalid"))).toThrow("payload unavailable")
  })

  test("invalidates delivery after renderer exit and disposal", () => {
    const { contents, delivery } = createFixture()
    delivery.markReady()

    contents.emit("render-process-gone")
    expect(delivery.send("desktop-window:event", "crashed")).toBe(false)

    contents.frame = new FrameFixture()
    delivery.markReady()
    delivery.dispose()
    expect(delivery.send("desktop-window:event", "disposed")).toBe(false)
  })
})
