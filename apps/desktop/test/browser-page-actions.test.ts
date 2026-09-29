import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { runBrowserPageAction, browserShortcut } from "../src/browser-page-actions"

describe("native browser page actions", () => {
  test("find waits for the matching final result and removes listeners", async () => {
    const contents = Object.assign(new EventEmitter(), {
      findInPage: () => 7,
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

  test("native keyboard shortcuts use the platform modifier and leave text input alone", () => {
    expect(browserShortcut({ key: "f", type: "keyDown", meta: true }, "darwin")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown", control: true }, "win32")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown", control: true }, "linux")).toBe("find")
    expect(browserShortcut({ key: "f", type: "keyDown" }, "darwin")).toBeUndefined()
    expect(browserShortcut({ key: "w", type: "keyUp", meta: true }, "darwin")).toBeUndefined()
    expect(browserShortcut({ key: "t", type: "keyDown", meta: true, shift: true }, "darwin")).toBeUndefined()
  })
})
