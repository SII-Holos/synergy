import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type ActivityDisplayMode = "full" | "balanced" | "minimal"

interface ActivitySwitchHarness {
  setMode: (mode: ActivityDisplayMode) => void
}

let fixtureDirectory: string
let dom: JSDOM
let harness: ActivitySwitchHarness

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-turn-activity-switch-fixture-"))
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
      import { createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { DataProvider } from ${JSON.stringify(dataContextPath)}
      import { DialogProvider } from ${JSON.stringify(dialogContextPath)}
      import { DiffComponentProvider } from ${JSON.stringify(diffContextPath)}
      import { MarkedProvider } from ${JSON.stringify(markedContextPath)}
      import { ResourceOpenProvider } from ${JSON.stringify(resourceOpenContextPath)}
      import { SessionTurn } from ${JSON.stringify(sessionTurnPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { setExternalMessageSlotLookup } from ${JSON.stringify(messageSlotsPath)}

      const sessionID = "session-activity-switch"
      const rootID = "user-activity-switch"
      const assistantID = "assistant-activity-switch"
      const secondAssistantID = "assistant-activity-switch-second"
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
        time: { created: 1, completed: 2 },
        finish: "stop",
      }
      const secondAssistantMessage = {
        ...assistantMessage,
        id: secondAssistantID,
        time: { created: 3, completed: 4 },
      }
      const toolPart = {
        id: "tool-activity-switch",
        sessionID,
        messageID: assistantID,
        type: "tool",
        callID: "call-activity-switch",
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
      const secondToolPart = {
        ...toolPart,
        id: "tool-activity-switch-second",
        messageID: secondAssistantID,
        callID: "call-activity-switch-second",
      }
      const answerPart = {
        id: "answer-activity-switch",
        sessionID,
        messageID: assistantID,
        type: "text",
        text: "Representative answer survives mode switches.",
      }
      const data = {
        session: [],
        session_status: { [sessionID]: { type: "idle" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, assistantMessage, secondAssistantMessage] },
        part: {
          [rootID]: [],
          [assistantID]: [answerPart, toolPart],
          [secondAssistantID]: [secondToolPart],
        },
      }
      const resourceController = {
        open: () => false,
        openAttachment: () => false,
        resolveWorkspacePath: (value) => value,
        openWorkspaceSource: () => false,
      }
      const EmptyDiff = () => null
      const [mode, setMode] = createSignal("minimal")
      const SlotProbe = (props) => <span data-test-slot={props.slot} data-test-message={props.messageId} />
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
                    <DataProvider data={data} directory="/workspace" serverUrl="http://localhost">
                      <SessionTurn
                        sessionID={sessionID}
                        messageID={rootID}
                        rootMessage={rootMessage}
                        messages={[rootMessage, assistantMessage, secondAssistantMessage]}
                        lastUserMessageID={rootID}
                        activityDisplay={mode()}
                      >
                        <span id="activity-switch-sentinel" hidden>stable</span>
                      </SessionTurn>
                    </DataProvider>
                  </DiffComponentProvider>
                </MarkedProvider>
              </ResourceOpenProvider>
            </DialogProvider>
          </I18nProvider>
        ),
        document.querySelector("#root"),
      )

      globalThis.__activitySwitchHarness = { setMode }
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
  harness = (globalThis as typeof globalThis & { __activitySwitchHarness: ActivitySwitchHarness })
    .__activitySwitchHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("SessionTurn activity display switching", () => {
  test("switches minimal to full without remounting or losing timeline items", async () => {
    const turn = document.querySelector('[data-component="session-turn"]')
    const sentinel = document.querySelector("#activity-switch-sentinel")
    const answer = document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')

    expect(turn?.getAttribute("data-activity-display")).toBe("minimal")
    expect(document.querySelector('[data-component="minimal-activity-summary"]')).not.toBeNull()
    expect(answer?.textContent).toContain("Representative answer survives mode switches.")

    expect(
      document.querySelector(`[data-test-slot="message.before"][data-test-message="assistant-activity-switch-second"]`),
    ).not.toBeNull()
    expect(
      document.querySelector(
        `[data-test-slot="message.actions"][data-test-message="assistant-activity-switch-second"]`,
      ),
    ).not.toBeNull()
    expect(
      document.querySelector(`[data-test-slot="message.after"][data-test-message="assistant-activity-switch-second"]`),
    ).not.toBeNull()

    harness.setMode("balanced")
    await waitForUpdate()

    const activityGroups = document.querySelectorAll(
      '[data-slot="session-turn-timeline-item"][data-kind="activity-group"]',
    )
    expect(activityGroups).toHaveLength(2)
    expect(activityGroups[0]?.hasAttribute("data-activity-continues")).toBe(true)
    expect(activityGroups[1]?.hasAttribute("data-activity-follows")).toBe(true)

    harness.setMode("full")
    await waitForUpdate()

    expect(document.querySelector('[data-component="session-turn"]')).toBe(turn)
    expect(document.querySelector("#activity-switch-sentinel")).toBe(sentinel)
    expect(turn?.getAttribute("data-activity-display")).toBe("full")
    expect(document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="tool"]')).toHaveLength(2)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')).toBe(answer)
    expect(document.querySelectorAll('[data-slot="session-turn-timeline-item"]')).toHaveLength(4)
  })
})
