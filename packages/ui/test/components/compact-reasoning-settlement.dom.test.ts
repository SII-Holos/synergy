import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

// Reproduces the working → settled transition on the REAL SessionTurn with the
// REAL reactive store, without remounting: the compact reasoning row must flip
// from the streaming line (spinner, no button) to the persistent expandable
// row as soon as the turn settles (session status idle + terminal message).
interface SettlementHarness {
  settle: () => void
}

let fixtureDirectory: string
let dom: JSDOM
let harness: SettlementHarness

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".compact-reasoning-settlement-fixture-"))
  const sessionTurnPath = path.resolve(import.meta.dir, "../../src/components/session-turn.tsx")
  const dataContextPath = path.resolve(import.meta.dir, "../../src/context/data.tsx")
  const dialogContextPath = path.resolve(import.meta.dir, "../../src/context/dialog.tsx")
  const diffContextPath = path.resolve(import.meta.dir, "../../src/context/diff.tsx")
  const markedContextPath = path.resolve(import.meta.dir, "../../src/context/marked.tsx")
  const resourceOpenContextPath = path.resolve(import.meta.dir, "../../src/context/resource-open.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const messageSlotsPath = path.resolve(import.meta.dir, "../../src/components/message-slots.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { I18nProvider } from "@lingui/solid"
      import { createStore } from "solid-js/store"
      import { render } from "solid-js/web"
      import { DataProvider } from ${JSON.stringify(dataContextPath)}
      import { DialogProvider } from ${JSON.stringify(dialogContextPath)}
      import { DiffComponentProvider } from ${JSON.stringify(diffContextPath)}
      import { MarkedProvider } from ${JSON.stringify(markedContextPath)}
      import { ResourceOpenProvider } from ${JSON.stringify(resourceOpenContextPath)}
      import { SessionTurn } from ${JSON.stringify(sessionTurnPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { setExternalMessageSlotLookup } from ${JSON.stringify(messageSlotsPath)}

      const sessionID = "session-settlement"
      const rootID = "user-settlement"
      const assistantID = "assistant-settlement"
      const reasoningID = "reasoning-settlement"
      const answerID = "answer-settlement"

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
      const assistantMessage = {
        id: assistantID,
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
        time: { created: 1 },
      }
      const reasoningPart = {
        id: reasoningID,
        sessionID,
        messageID: assistantID,
        type: "reasoning",
        text: "## Planning\\nThinking through the request step by step.",
      }
      const answerPart = {
        id: answerID,
        sessionID,
        messageID: assistantID,
        type: "text",
        text: "Here is the final answer.",
      }

      const [state, setState] = createStore({
        session: [],
        session_status: { [sessionID]: { type: "busy" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, assistantMessage] },
        part: { [rootID]: [], [assistantID]: [reasoningPart, answerPart] },
      })

      const resourceController = {
        open: () => false,
        openAttachment: () => false,
        resolveWorkspacePath: (value) => value,
        openWorkspaceSource: () => false,
      }
      const EmptyDiff = () => null
      const SlotProbe = (props) => <span data-test-slot={props.slot} />
      setExternalMessageSlotLookup((slot) =>
        ["message.before", "message.actions", "message.after"].includes(slot)
          ? [{ id: "probe-" + slot, component: SlotProbe }]
          : [],
      )

      render(
        () => (
          <I18nProvider i18n={setupI18n()}>
            <DialogProvider>
              <ResourceOpenProvider value={resourceController}>
                <MarkedProvider>
                  <DiffComponentProvider component={EmptyDiff}>
                    <DataProvider data={state} directory="/workspace" serverUrl="http://localhost">
                      <SessionTurn
                        sessionID={sessionID}
                        messageID={rootID}
                        rootMessage={rootMessage}
                        messages={state.message[sessionID]}
                        lastUserMessageID={rootID}
                        activityDisplay="balanced"
                        compactReasoning={true}
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

      globalThis.__settlementHarness = {
        settle: () => {
          setState("session_status", sessionID, { type: "idle" })
          setState("message", sessionID, (messages) =>
            messages.map((m) =>
              m.id === assistantID ? { ...m, time: { ...m.time, completed: 5000 }, finish: "stop" } : m,
            ),
          )
        },
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
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0)) as unknown as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
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
  harness = (globalThis as typeof globalThis & { __settlementHarness: SettlementHarness }).__settlementHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Compact reasoning settlement transition", () => {
  test("streams as a running line and settles into a clickable row without remount", async () => {
    expect(document.querySelector('[data-component="compact-reasoning"][data-state="running"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-trigger"]')).toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).not.toBeNull()

    harness.settle()
    await waitForUpdate()
    await waitForUpdate()

    const settled = document.querySelector('[data-component="compact-reasoning"][data-state="settled"]')
    expect(settled).not.toBeNull()
    expect(document.querySelector('[data-component="compact-reasoning"][data-state="running"]')).toBeNull()

    const trigger = document.querySelector('[data-slot="compact-reasoning-trigger"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-detail"]')).toBeNull()

    trigger.click()
    await waitForUpdate()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector('[data-slot="compact-reasoning-detail"]')).not.toBeNull()
  })
})
