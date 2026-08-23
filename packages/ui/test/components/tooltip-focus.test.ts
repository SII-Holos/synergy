import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"

// The listener module binds against the browser DOM, so this suite installs a
// jsdom global window before importing it (same pattern as markdown-sanitize).
let attachFocusListeners: typeof import("../../src/components/tooltip-focus").attachFocusListeners
let dom: JSDOM
let listenersAfterDetach: (type: string) => number

beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>")
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  ;({ attachFocusListeners } = await import("../../src/components/tooltip-focus"))
})

afterAll(() => {
  dom?.window.close()
})

describe("attachFocusListeners", () => {
  test("attaches focus/blur listeners and detach removes them all", () => {
    const element = document.createElement("button")
    document.body.appendChild(element)
    let detachCalls = 0
    let focusCalls = 0
    let blurCalls = 0

    const detach = attachFocusListeners(
      [element],
      () => focusCalls++,
      () => blurCalls++,
    )

    element.dispatchEvent(new dom.window.Event("focus"))
    element.dispatchEvent(new dom.window.Event("blur"))
    expect(focusCalls).toBe(1)
    expect(blurCalls).toBe(1)

    detach()
    element.dispatchEvent(new dom.window.Event("focus"))
    element.dispatchEvent(new dom.window.Event("blur"))
    expect(focusCalls).toBe(1)
    expect(blurCalls).toBe(1)
    expect(detachCalls).toBe(0)
  })

  test("ignores non-element children and supports array inputs", () => {
    const element = document.createElement("div")
    document.body.appendChild(element)
    let focusCalls = 0

    const detach = attachFocusListeners(
      ["not-an-element", element],
      () => focusCalls++,
      () => {},
    )
    element.dispatchEvent(new dom.window.Event("focus"))
    expect(focusCalls).toBe(1)
    detach()
  })

  test("detach is idempotent", () => {
    const element = document.createElement("span")
    document.body.appendChild(element)
    let focusCalls = 0
    const detach = attachFocusListeners(
      [element],
      () => focusCalls++,
      () => {},
    )
    detach()
    detach()
    element.dispatchEvent(new dom.window.Event("focus"))
    expect(focusCalls).toBe(0)
  })
})
