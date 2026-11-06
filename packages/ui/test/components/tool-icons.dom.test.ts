import { afterAll, beforeAll, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"
import type { IconSource } from "../../src/components/icon"

let dom: JSDOM
let fixture: { register(): void; unregister(): void; dispose(): void; setOptionalIcon(value?: IconSource): void }

beforeAll(async () => {
  const entry = await domFixture("tool-icons.dom")
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
  const window = dom.window
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    ResizeObserver: ResizeObserverStub,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  })
  await import(entry)
  fixture = (globalThis as unknown as { toolIconFixture: typeof fixture }).toolIconFixture
}, 60000)

afterAll(() => {
  fixture?.dispose()
  dom?.window.close()
})

function icons(tool: string, surface: "process" | "detail") {
  return document.querySelector(`[data-tool-case="${tool}"] [data-surface="${surface}"] [data-component="icon"]`)!
}

test("an optional plugin icon can be absent, populated and withdrawn without unmounting its surface", () => {
  const surface = document.getElementById("optional-icon")!
  expect(surface.querySelector("svg,img")).toBeNull()
  fixture.setOptionalIcon("puzzle")
  expect(surface.querySelector(".lucide-puzzle")).not.toBeNull()
  fixture.setOptionalIcon({ sources: [], fallback: "package" })
  expect(surface.querySelector(".lucide-package")).not.toBeNull()
  fixture.setOptionalIcon()
  expect(surface.querySelector("svg,img")).toBeNull()
  expect(document.getElementById("optional-icon")).toBe(surface)
})

test("real activity rows and specialized cards use the selected glyph", () => {
  for (const [tool, glyph] of [
    ["bash", "square-terminal"],
    ["read", "book-open-text"],
    ["skill", "puzzle"],
  ]) {
    expect(icons(tool!, "process").querySelector(`.lucide-${glyph}`)).not.toBeNull()
    expect(icons(tool!, "detail").querySelector(`.lucide-${glyph}`)).not.toBeNull()
  }
  expect(document.querySelector("#reasoning-icon .lucide-brain-circuit")).not.toBeNull()
})

test("plugin icon registration and withdrawal update both surfaces", () => {
  const tool = "plugin__example__lookup"
  expect(icons(tool, "process").querySelector(".lucide-package")).not.toBeNull()
  fixture.register()
  for (const surface of ["process", "detail"] as const)
    expect(icons(tool, surface).querySelector("[data-tool-logo=example]")).not.toBeNull()
  fixture.unregister()
  for (const surface of ["process", "detail"] as const)
    expect(icons(tool, surface).querySelector(".lucide-package")).not.toBeNull()
})

test("MCP images survive specialized renderers, with theme variants and image-error fallback", () => {
  for (const tool of ["mcp__notion__fetch", "mcp__anysearch__search"]) {
    for (const surface of ["process", "detail"] as const) {
      const element = icons(tool, surface)
      const light = element.querySelector<HTMLImageElement>('[data-theme="light"] img')!
      const dark = element.querySelector<HTMLImageElement>('[data-theme="dark"] img')!
      expect(light.src).toStartWith("data:image/svg+xml;base64,")
      expect(dark.src).not.toBe(light.src)
      light.dispatchEvent(new dom.window.Event("error"))
      expect(element.querySelector('[data-theme="light"] img')).toBeNull()
      expect(element.querySelector('[data-theme="light"] svg')).not.toBeNull()
    }
  }
  expect(icons("mcp__other__lookup", "process").querySelector(".lucide-cable")).not.toBeNull()
})
