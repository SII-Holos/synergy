import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface SessionSwitchStressHarness {
  replaceMessageBucket: (sessionID: string, messages: unknown[] | undefined) => void
  replacePartBucket: (messageID: string, parts: unknown[] | undefined) => void
  replacePermissionBucket: (sessionID: string, permissions: unknown[] | undefined) => void
  replaceSessionStatus: (sessionID: string, status: unknown | undefined) => void
  replaceWithFreshObjects: () => void
  clearAllBuckets: () => void
  restoreBuckets: () => void
  getErrors: () => number
}

let fixtureDirectory: string
let harness: SessionSwitchStressHarness
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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-switch-stress-fixture-"))
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
      import { ErrorBoundary } from "solid-js"
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

      const sessionID = "session-stress"
      const rootID = "user-stress"
      const doneID = "assistant-stress"

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

      // Replacement buckets must carry structurally complete messages: the
      // render chain reads time/role/rootID off them. In production these
      // always exist on store messages; the test targets *missing buckets*
      // (the session-switch intermediate state), not malformed objects.
      const buildUser = (id) => ({
        id,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "synergy",
        model: { providerID: "provider", modelID: "model" },
        isRoot: true,
        rootID: id,
        visible: true,
      })
      const buildAssistant = (id) => ({
        ...baseAssistant,
        id,
        time: { created: 2, completed: 3 },
      })

      const doneTextPart = { id: "part-stress", sessionID, messageID: doneID, type: "text", text: "Stress answer" }

      const [store, setStore] = createStore({
        session: [],
        session_status: { [sessionID]: { type: "busy" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, doneAssistant] },
        part: { [doneID]: [doneTextPart] },
      })

      setExternalToolLookup(() => undefined)
      const resourceController = {
        open: () => false,
        openAttachment: () => false,
        resolveWorkspacePath: (value) => value,
        openWorkspaceSource: () => false,
      }
      const EmptyDiff = () => null

      // A render error inside SessionTurn (its own memo chain) escapes the
      // per-item TimelineDisplay boundaries and would bubble here. Count it so
      // the test can assert zero errors across rapid switch mutations.
      let boundaryErrors = 0
      let windowErrors = 0
      window.addEventListener("error", () => {
        windowErrors++
      })

      const fullState = () => ({
        session: [],
        session_status: { [sessionID]: { type: "busy" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, doneAssistant] },
        part: { [doneID]: [doneTextPart] },
      })
      const emptyState = () => ({
        session: [],
        session_status: {},
        session_diff: {},
        permission: {},
        message: {},
        part: {},
      })

      render(
        () => (
          <I18nProvider i18n={setupI18n()}>
            <DialogProvider>
              <ResourceOpenProvider value={resourceController}>
                <MarkedProvider>
                  <DiffComponentProvider component={EmptyDiff}>
                    <DataProvider data={store} directory="/workspace" serverUrl="http://localhost">
                      <ErrorBoundary
                        fallback={(err) => {
                          boundaryErrors++
                          console.error("[stress] boundary caught", err)
                          return null
                        }}
                      >
                        <SessionTurn
                          sessionID={sessionID}
                          messageID={rootID}
                          rootMessage={rootMessage}
                          messages={store.message[sessionID] ?? []}
                          lastUserMessageID={rootID}
                          activityDisplay="balanced"
                        />
                      </ErrorBoundary>
                    </DataProvider>
                  </DiffComponentProvider>
                </MarkedProvider>
              </ResourceOpenProvider>
            </DialogProvider>
          </I18nProvider>
        ),
        document.querySelector("#root"),
      )

      globalThis.__sessionSwitchStressHarness = {
        replaceMessageBucket: (sid, messages) => setStore("message", sid, messages),
        replacePartBucket: (mid, parts) => setStore("part", mid, parts),
        replacePermissionBucket: (sid, permissions) => setStore("permission", sid, permissions),
        replaceSessionStatus: (sid, status) => setStore("session_status", sid, status),
        replaceWithFreshObjects: () => {
          setStore("message", sessionID, [buildUser(rootID), buildAssistant(doneID)])
          setStore("part", doneID, [doneTextPart])
          setStore("permission", sessionID, [])
          setStore("session_status", sessionID, { type: "busy" })
        },
        clearAllBuckets: () => setStore(emptyState()),
        restoreBuckets: () => setStore(fullState()),
        getErrors: () => boundaryErrors + windowErrors,
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
  harness = (globalThis as typeof globalThis & { __sessionSwitchStressHarness: SessionSwitchStressHarness })
    .__sessionSwitchStressHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

const answerRow = () => {
  const rows = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="text"]')
  for (const row of rows) {
    if (row.textContent?.includes("Stress answer")) return row
  }
  return null
}

describe("SessionTurn session-switch resilience", () => {
  test("renders the settled answer before stress mutations", async () => {
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
    expect(harness.getErrors()).toBe(0)
  })

  test("rapid bucket replacement and clearing does not throw", async () => {
    const sid = "session-stress"
    const mid = "assistant-stress"
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)

    for (let i = 0; i < 5; i++) {
      harness.replaceMessageBucket(sid, undefined)
      harness.replacePartBucket(mid, undefined)
      harness.replacePermissionBucket(sid, undefined)
      harness.replaceSessionStatus(sid, undefined)
      await new Promise((resolve) => setTimeout(resolve, 5))
      harness.replaceWithFreshObjects()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })

  test("whole-store clear and restore does not throw", async () => {
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)

    harness.clearAllBuckets()
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.restoreBuckets()

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })

  test("rapid final content is still correct after repeated churn", async () => {
    for (let i = 0; i < 10; i++) {
      harness.clearAllBuckets()
      await new Promise((resolve) => setTimeout(resolve, 3))
      harness.restoreBuckets()
      await new Promise((resolve) => setTimeout(resolve, 3))
    }

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })
})
