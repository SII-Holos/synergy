import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface MessagePartResult {
  escapedError?: string
  reports: string[]
  text: string | null
  hasLocalError: boolean
}

let fixtureDirectory: string
let result: MessagePartResult
let dom: JSDOM

beforeAll(async () => {
  // The fixture compiles a real Solid bundle through Vite before exercising
  // the lifecycle; keep this hook well above the default 5s test timeout so
  // direct `bun test` invocations do not fail on cold caches or slow disks.
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".message-part-error-boundary-fixture-"))
  const messagePartPath = path.resolve(import.meta.dir, "../../src/components/message-part.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const entry = path.join(fixtureDirectory, "main.ts")

  await Bun.write(
    entry,
    `
      import { createComponent, ErrorBoundary } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { Part, registerPartComponent } from ${JSON.stringify(messagePartPath)}

      const reports: string[] = []
      console.error = (...args) => {
        reports.push(args.map((value) => value instanceof Error ? value.message : JSON.stringify(value)).join(" "))
      }

      let stale = false
      const rawPart = {
        id: "part-renderer-failure",
        sessionID: "session-switch-target",
        messageID: "message-renderer-failure",
        type: "stale-boundary-fixture",
        secretPayload: "must-not-enter-diagnostics",
      }
      const part = new Proxy(rawPart, {
        get(target, property, receiver) {
          if (stale) throw new Error("Stale read from <Show>.")
          return Reflect.get(target, property, receiver)
        },
      })
      const message = {
        id: rawPart.messageID,
        sessionID: rawPart.sessionID,
        role: "assistant",
        time: { created: 1 },
        parentID: "message-user",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: "/private/project", root: "/private/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }

      registerPartComponent(rawPart.type, () => {
        stale = true
        throw new Error("original renderer failure")
      })

      const i18n = setupI18n()
      let escapedError: string | undefined
      const root = document.querySelector("#root")!
      render(
        () => createComponent(ErrorBoundary, {
          fallback(error) {
            escapedError = error instanceof Error ? error.message : String(error)
            const node = document.createElement("div")
            node.dataset.escapedError = escapedError
            return node
          },
          get children() {
            return createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(Part, { part, message })
              },
            })
          },
        }),
        root,
      )

      globalThis.__messagePartResult = {
        escapedError,
        reports,
        text: root.textContent,
        hasLocalError: !!root.querySelector(".plugin-error-card"),
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    resolve: {
      // Vite resolves @ericsanchezok/synergy-plugin/* through the exports map's
      // "import" condition, which points at dist/ artifacts that only exist
      // after the plugin package is built. CI checks out a clean tree, so
      // point the theme subpath at the plugin sources like the other fixture
      // tests do.
      alias: { "@ericsanchezok/synergy-plugin/theme": pluginThemePath },
    },
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
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  result = (globalThis as typeof globalThis & { __messagePartResult: MessagePartResult }).__messagePartResult
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("message part renderer error boundary", () => {
  test("keeps the original renderer failure local after its reactive owner becomes stale", () => {
    expect(result.escapedError).toBeUndefined()
    expect(result.hasLocalError).toBe(true)
    expect(result.text).toContain("original renderer failure")
    expect(result.text).toContain("stale-boundary-fixture")
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]).toContain("original renderer failure")
    expect(result.reports[0]).toContain("session-switch-target")
    expect(result.reports[0]).toContain("message-renderer-failure")
    expect(result.reports[0]).toContain("part-renderer-failure")
    expect(result.reports[0]).not.toContain("must-not-enter-diagnostics")
    expect(result.reports[0]).not.toContain("/private/project")
  })
})
