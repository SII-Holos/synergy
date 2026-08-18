import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface ProjectionMemoizationHarness {
  setStreamText: (text: string) => void
  setSessionStatus: (status: { type: string }) => void
  getToolLookups: () => number
}

let fixtureDirectory: string
let harness: ProjectionMemoizationHarness
let dom: JSDOM

const waitUntil = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-turn-projection-memoization-fixture-"))
  const sessionTurnPath = path.resolve(import.meta.dir, "../../src/components/session-turn.tsx")
  const dataContextPath = path.resolve(import.meta.dir, "../../src/context/data.tsx")
  const dialogContextPath = path.resolve(import.meta.dir, "../../src/context/dialog.tsx")
  const diffContextPath = path.resolve(import.meta.dir, "../../src/context/diff.tsx")
  const markedContextPath = path.resolve(import.meta.dir, "../../src/context/marked.tsx")
  const resourceOpenContextPath = path.resolve(import.meta.dir, "../../src/context/resource-open.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const toolRegistryLazyPath = path.resolve(import.meta.dir, "../../src/components/tool-registry-lazy.ts")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { I18nProvider } from "@lingui/solid"
      import { render } from "solid-js/web"
      import { createStore } from "solid-js/store"
      import { DataProvider } from ${JSON.stringify(dataContextPath)}
      import { DialogProvider } from ${JSON.stringify(dialogContextPath)}
      import { DiffComponentProvider } from ${JSON.stringify(diffContextPath)}
      import { MarkedProvider } from ${JSON.stringify(markedContextPath)}
      import { ResourceOpenProvider } from ${JSON.stringify(resourceOpenContextPath)}
      import { SessionTurn } from ${JSON.stringify(sessionTurnPath)}
      import { setExternalToolLookup } from ${JSON.stringify(toolRegistryLazyPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}

      const sessionID = "session-projection-memoization"
      const rootID = "user-projection-memoization"
      const doneID = "assistant-done"
      const streamID = "assistant-stream"

      const rootMessage = {
        id: rootID,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "synergy",
        model: { providerID: "provider", modelID: "model" },
        isRoot: true,
        rootID,
        visible: true,
      }
      const baseAssistant = {
        sessionID,
        role: "assistant",
        parentID: rootID,
        rootID,
        mode: "test",
        agent: "synergy",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "model",
        providerID: "provider",
      }
      const doneAssistant = { ...baseAssistant, id: doneID, time: { created: 2, completed: 3 } }
      const streamAssistant = { ...baseAssistant, id: streamID, time: { created: 4 } }

      const doneTextPart = { id: "part-done", sessionID, messageID: doneID, type: "text", text: "Done answer" }
      const doneToolPart = {
        id: "part-done-tool",
        sessionID,
        messageID: doneID,
        type: "tool",
        callID: "call-done-tool",
        tool: "fixture_read_file",
        state: {
          status: "completed",
          input: { filePath: "/workspace/src/example.ts" },
          output: "Read example.ts",
          title: "Read example.ts",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }
      const streamTextPart = { id: "part-stream", sessionID, messageID: streamID, type: "text", text: "stream " }

      const [store, setStore] = createStore({
        session: [],
        session_status: { [sessionID]: { type: "busy" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, doneAssistant, streamAssistant] },
        part: { [doneID]: [doneTextPart, doneToolPart], [streamID]: [streamTextPart] },
      })

      // Balanced activity projection resolves the external tool renderer for
      // every ordinary tool part, so each re-projection of the settled message
      // invokes this lookup exactly once — a deterministic, DOM-independent
      // signal for projection work.
      let toolLookups = 0
      setExternalToolLookup(() => {
        toolLookups++
        return undefined
      })

      const resourceController = {
        open: () => false,
        openAttachment: () => false,
        resolveWorkspacePath: (value) => value,
        openWorkspaceSource: () => false,
      }
      const EmptyDiff = () => null

      render(
        () => (
          <I18nProvider i18n={setupI18n()}>
            <DialogProvider>
              <ResourceOpenProvider value={resourceController}>
                <MarkedProvider>
                  <DiffComponentProvider component={EmptyDiff}>
                    <DataProvider data={store} directory="/workspace" serverUrl="http://localhost">
                      <SessionTurn
                        sessionID={sessionID}
                        messageID={rootID}
                        rootMessage={rootMessage}
                        messages={store.message[sessionID]}
                        lastUserMessageID={rootID}
                        activityDisplay="balanced"
                      />
                    </DataProvider>
                  </DiffComponentProvider>
                </MarkedProvider>
              </ResourceOpenProvider>
            </DialogProvider>
          </I18nProvider>
        ),
        document.querySelector("#root"),
      )

      globalThis.__projectionMemoizationHarness = {
        setStreamText: (text) => setStore("part", streamID, 0, "text", text),
        setSessionStatus: (status) => setStore("session_status", sessionID, status),
        getToolLookups: () => toolLookups,
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    resolve: {
      alias: { "@ericsanchezok/synergy-plugin/theme": pluginThemePath },
    },
    worker: { format: "es" },
    build: {
      outDir: path.join(fixtureDirectory, "dist"),
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "fixture" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })

  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
  })
  const window = dom.window
  const realGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element) => {
    const style = realGetComputedStyle(element)
    Object.defineProperty(style, "animationName", { configurable: true, value: "none" })
    return style
  }) as typeof window.getComputedStyle
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
  window.HTMLElement.prototype.scrollTo = () => {}

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
    MutationObserver: window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as typeof globalThis & { __projectionMemoizationHarness: ProjectionMemoizationHarness })
    .__projectionMemoizationHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

const doneTextRow = () => {
  const rows = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="text"]')
  for (const row of rows) {
    if (row.textContent?.includes("Done answer")) return row
  }
  return null
}

describe("SessionTurn streaming projection memoization", () => {
  test("streaming deltas re-project only the streaming message", async () => {
    expect(await waitUntil(() => harness.getToolLookups() > 0)).toBe(true)
    expect(await waitUntil(() => doneTextRow() !== null)).toBe(true)

    const lookupsAfterMount = harness.getToolLookups()
    const textRow = doneTextRow()
    expect(textRow).not.toBeNull()

    harness.setStreamText("stream token a")
    expect(await waitUntil(() => harness.getToolLookups() > lookupsAfterMount, 300)).toBe(false)

    harness.setStreamText("stream token b")
    expect(await waitUntil(() => harness.getToolLookups() > lookupsAfterMount, 300)).toBe(false)

    // Deltas re-project only the streaming message: the settled message was
    // not re-projected (no new tool lookups) and its row stays mounted.
    expect(harness.getToolLookups()).toBe(lookupsAfterMount)
    expect(doneTextRow()).toBe(textRow)
  })

  test("settling re-projects the settled message once and reveals the copy action", async () => {
    expect(await waitUntil(() => harness.getToolLookups() > 0)).toBe(true)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="copy-markdown"]')).toBeNull()

    const lookupsBeforeSettle = harness.getToolLookups()
    harness.setSessionStatus({ type: "idle" })

    // Settlement flips working() off and re-projects the settled message once
    // (its tool part resolves the renderer again), revealing Copy Markdown.
    expect(await waitUntil(() => harness.getToolLookups() > lookupsBeforeSettle)).toBe(true)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="copy-markdown"]')).not.toBeNull()
  })
})
