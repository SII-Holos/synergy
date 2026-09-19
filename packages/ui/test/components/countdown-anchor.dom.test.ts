import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type CountdownKind = "auto_background" | "timeout" | "remaining"

interface CountdownFixtureProps {
  seconds: number
  active: boolean
  startedAt?: number
  kind?: CountdownKind
}

interface CountdownHarness {
  mount: (props: CountdownFixtureProps) => void
  unmount: () => void
  exists: () => boolean
  text: () => string | null
}

const expiredCases: Array<[CountdownKind, string]> = [
  ["auto_background", "backgrounded"],
  ["timeout", "timed out"],
  ["remaining", "past limit"],
]

let fixtureDirectory: string
let dom: JSDOM
let harness: CountdownHarness

function countdownElement(): Element | null {
  return document.querySelector('[data-component="countdown"]')
}

function remainingSeconds(): number {
  const digits = harness.text()?.match(/(\d+)s/)?.[1]
  return digits === undefined ? Number.NaN : Number(digits)
}

// The fixture compiles a real Solid bundle through Vite before exercising the
// component, so keep the hook well above the default test timeout for cold caches.
beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".countdown-anchor-dom-fixture-"))
  const countdownPath = path.resolve(import.meta.dir, "../../src/components/countdown.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { Countdown } from ${JSON.stringify(countdownPath)}

      const i18n = setupI18n()
      const host = document.querySelector("#root")
      let dispose

      const mount = (props) => {
        dispose?.()
        host.replaceChildren()
        dispose = render(
          () => (
            <I18nProvider i18n={i18n}>
              <Countdown {...props} />
            </I18nProvider>
          ),
          host,
        )
      }

      const unmount = () => {
        dispose?.()
        dispose = undefined
        host.replaceChildren()
      }

      const current = () => host.querySelector('[data-component="countdown"]')

      ;(globalThis as any).__countdownAnchorDomHarness = {
        mount,
        unmount,
        exists: () => current() !== null,
        text: () => current()?.textContent ?? null,
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    worker: { format: "es" },
    build: {
      outDir: path.join(fixtureDirectory, "dist"),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry,
        formats: ["es"],
        fileName: "fixture",
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  })

  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
  })
  const window = dom.window
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  window.ResizeObserver = class ResizeObserver {
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
    HTMLHeadElement: window.HTMLHeadElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as unknown as { __countdownAnchorDomHarness: CountdownHarness }).__countdownAnchorDomHarness
}, 60000)

afterAll(async () => {
  harness?.unmount()
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Countdown start anchor DOM behavior", () => {
  test("renders nothing without a real start anchor", () => {
    harness.mount({ seconds: 30, active: true, kind: "timeout" })
    expect(countdownElement()).toBeNull()
    expect(harness.exists()).toBe(false)

    harness.mount({ seconds: 30, active: true, startedAt: Date.now(), kind: "timeout" })
    expect(countdownElement()).not.toBeNull()
  })

  test("remounting keeps the server anchor instead of restarting from mount time", () => {
    const startedAt = Date.now() - 200_000
    harness.mount({ seconds: 300, active: true, startedAt, kind: "remaining" })

    const first = remainingSeconds()
    expect(first).toBeGreaterThanOrEqual(95)
    expect(first).toBeLessThanOrEqual(101)

    harness.unmount()
    expect(countdownElement()).toBeNull()

    harness.mount({ seconds: 300, active: true, startedAt, kind: "remaining" })
    const second = remainingSeconds()
    expect(second).toBeGreaterThanOrEqual(95)
    expect(second).toBeLessThanOrEqual(first)

    harness.unmount()
    harness.mount({ seconds: 300, active: true, kind: "remaining" })
    expect(countdownElement()).toBeNull()
  })

  test.each([
    ["auto_background", /^\d+s to background$/],
    ["timeout", /^\d+s to timeout$/],
    ["remaining", /^\d+s remaining$/],
  ] as Array<[CountdownKind, RegExp]>)("labels a live %s window with its remaining seconds", (kind, pattern) => {
    harness.mount({ seconds: 30, active: true, startedAt: Date.now() - 1_000, kind })

    expect(harness.text()).toMatch(pattern)
    expect(remainingSeconds()).toBeGreaterThan(0)
    expect(countdownElement()?.getAttribute("data-expired")).toBe("false")
  })

  test.each(expiredCases)("expired %s countdowns render %s instead of a zero timer", (kind, label) => {
    harness.mount({ seconds: 30, active: true, startedAt: Date.now() - 60_000, kind })

    const element = countdownElement()
    expect(element).not.toBeNull()
    expect(element?.textContent).not.toBe("0s timeout")
    expect(element?.textContent).toBe(label)
    expect(element?.getAttribute("data-expired")).toBe("true")
  })
})
