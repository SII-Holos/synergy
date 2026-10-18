import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { runBrowserPageAction, browserShortcut } from "../src/browser-page-actions"

describe("native browser page actions", () => {
  test("find waits for the matching final result and removes listeners", async () => {
    const contents = Object.assign(new EventEmitter(), {
      findInPage: (_text: string, options: { findNext: boolean }) => {
        expect(options.findNext).toBe(true)
        return 7
      },
      stopFindInPage: () => {},
    })
    const result = runBrowserPageAction(contents as never, { type: "find", text: "needle", forward: true, next: false })
    contents.emit("found-in-page", {}, { requestId: 8, finalUpdate: true, matches: 99, activeMatchOrdinal: 9 })
    contents.emit("found-in-page", {}, { requestId: 7, finalUpdate: false, matches: 1, activeMatchOrdinal: 1 })
    contents.emit("found-in-page", {}, { requestId: 7, finalUpdate: true, matches: 3, activeMatchOrdinal: 2 })
    expect(await result).toEqual({ type: "find", matches: 3, active: 2 })
    expect(contents.listenerCount("found-in-page")).toBe(0)
  })

  test("zoom changes webpage scale without changing the application", async () => {
    let zoom = 1
    const contents = { getZoomFactor: () => zoom, setZoomFactor: (value: number) => (zoom = value) }
    expect(await runBrowserPageAction(contents as never, { type: "zoom", factor: 1.25 })).toEqual({
      type: "zoom",
      factor: 1.25,
    })
    expect(zoom).toBe(1.25)
    await expect(runBrowserPageAction(contents as never, { type: "zoom", factor: 100 })).rejects.toThrow()
  })

  test("cover captures a still of the page that is currently shown", async () => {
    const still = Buffer.from("still")
    const contents = {
      getURL: () => "https://example.test/page",
      isDestroyed: () => false,
      capturePage: async () => ({
        isEmpty: () => false,
        toJPEG: (quality: number) => (quality === 75 ? still : Buffer.alloc(0)),
      }),
    }
    expect(await runBrowserPageAction(contents as never, { type: "cover" })).toEqual({
      type: "cover",
      url: "https://example.test/page",
      dataUrl: `data:image/jpeg;base64,${still.toString("base64")}`,
    })
  })

  test("cover refuses an empty capture so a blank still cannot replace the page", async () => {
    const contents = {
      getURL: () => "https://example.test/page",
      isDestroyed: () => false,
      capturePage: async () => ({ isEmpty: () => true, toJPEG: () => Buffer.alloc(0) }),
    }
    await expect(runBrowserPageAction(contents as never, { type: "cover" })).rejects.toThrow()
  })

  test("cover refuses a capture that raced a navigation", async () => {
    let url = "https://example.test/page"
    const contents = {
      getURL: () => url,
      isDestroyed: () => false,
      capturePage: async () => {
        url = "https://example.test/next"
        return { isEmpty: () => false, toJPEG: () => Buffer.from("still") }
      },
    }
    await expect(runBrowserPageAction(contents as never, { type: "cover" })).rejects.toThrow()
  })

  test("native keyboard shortcuts use the platform modifier and leave text input alone", () => {
    expect(browserShortcut({ key: "f", type: "keyDown", meta: true }, "darwin")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown", control: true }, "win32")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown", control: true }, "linux")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown" }, "darwin")).toBeUndefined()
    expect(browserShortcut({ key: "w", type: "keyUp", meta: true }, "darwin")).toBeUndefined()
    expect(browserShortcut({ key: "t", type: "keyDown", meta: true, shift: true }, "darwin")).toBeUndefined()
  })
})
