import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

// The fixture compiles the real CompactReasoningLine through Vite before
// exercising the scroll-follow and settled-expansion behavior, matching the
// activity-trace DOM harness. JSDOM has no layout engine, so scroll geometry
// is stubbed on the scroller element.
interface CompactReasoningHarness {
  setText: (text: string) => void
  setRunning: (running: boolean) => void
}

let fixtureDirectory: string
let dom: JSDOM
let harness: CompactReasoningHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function scroller(): HTMLElement {
  return document.querySelector('[data-slot="compact-reasoning-scroller"]') as HTMLElement
}

function setScrollerGeometry(scrollWidth: number, clientWidth: number) {
  const el = scroller()
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth })
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth })
}

function userScrollTo(left: number) {
  const el = scroller()
  el.scrollLeft = left
  el.dispatchEvent(new dom.window.Event("scroll"))
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".compact-reasoning-dom-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../src/components/compact-reasoning.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { CompactReasoningLine } from ${JSON.stringify(componentPath)}

      const i18n = setupI18n()
      const [text, setText] = createSignal("Planning the reply")
      const [running, setRunning] = createSignal(true)
      const root = document.getElementById("root")
      render(
        () => (
          <I18nProvider i18n={i18n}>
            <CompactReasoningLine fullText={text()} running={running()} />
          </I18nProvider>
        ),
        root,
      )
      ;(globalThis as unknown as { __compactReasoningHarness: unknown }).__compactReasoningHarness = {
        setText,
        setRunning,
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

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as unknown as { __compactReasoningHarness: CompactReasoningHarness }).__compactReasoningHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("CompactReasoningLine DOM behavior", () => {
  test("renders a Thinking prefix with spinner and the streamed text while running", () => {
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-label"]')?.textContent).toBe("Thinking")
    expect(document.querySelector('[data-slot="compact-reasoning-text"]')?.textContent).toBe("Planning the reply")
    expect(document.querySelector('[data-slot="compact-reasoning-trigger"]')).toBeNull()
  })

  test("follows the newest text to the tail when the line overflows", async () => {
    setScrollerGeometry(500, 100)
    harness.setText("Continuing the reasoning well past the visible edge of the row")
    await wait(20)
    expect(scroller().scrollLeft).toBe(400)
  })

  test("stops following when the user scrolls back, and resumes at the tail", async () => {
    setScrollerGeometry(500, 100)
    userScrollTo(150)
    harness.setText("The user is reading earlier reasoning, so do not steal the view")
    await wait(20)
    expect(scroller().scrollLeft).toBe(150)

    userScrollTo(400)
    harness.setText("The user returned to the tail, so follow again")
    await wait(20)
    expect(scroller().scrollLeft).toBe(400)
  })

  test("settles into a persistent expandable Thinking row", async () => {
    harness.setText("## Planning\nFirst reasoning line.\n- Second reasoning line.")
    harness.setRunning(false)
    await wait(20)

    const trigger = document.querySelector('[data-slot="compact-reasoning-trigger"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-label"]')?.textContent).toBe("Thinking")
    expect(document.querySelector('[data-slot="compact-reasoning-summary"]')?.textContent).toBe("Planning")
    expect(document.querySelector('[data-slot="compact-reasoning-detail"]')).toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")

    trigger.click()
    await wait(20)

    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector('[data-slot="compact-reasoning-detail-text"]')?.textContent).toBe(
      "## Planning\nFirst reasoning line.\n- Second reasoning line.",
    )

    trigger.click()
    await wait(20)
    expect(document.querySelector('[data-slot="compact-reasoning-detail"]')).toBeNull()
  })
})
