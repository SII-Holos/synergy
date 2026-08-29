import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

let fixtureDirectory: string
let dom: JSDOM

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-turn-attachments-collapse-fixture-"))
  const sessionTurnPath = path.resolve(import.meta.dir, "../../src/components/session-turn.tsx")
  const dataContextPath = path.resolve(import.meta.dir, "../../src/context/data.tsx")
  const dialogContextPath = path.resolve(import.meta.dir, "../../src/context/dialog.tsx")
  const diffContextPath = path.resolve(import.meta.dir, "../../src/context/diff.tsx")
  const markedContextPath = path.resolve(import.meta.dir, "../../src/context/marked.tsx")
  const resourceOpenContextPath = path.resolve(import.meta.dir, "../../src/context/resource-open.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { I18nProvider } from "@lingui/solid"
      import { render } from "solid-js/web"
      import { DataProvider } from ${JSON.stringify(dataContextPath)}
      import { DialogProvider } from ${JSON.stringify(dialogContextPath)}
      import { DiffComponentProvider } from ${JSON.stringify(diffContextPath)}
      import { MarkedProvider } from ${JSON.stringify(markedContextPath)}
      import { ResourceOpenProvider } from ${JSON.stringify(resourceOpenContextPath)}
      import { SessionTurn } from ${JSON.stringify(sessionTurnPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}

      const sessionID = "session-attachments-collapse"
      const rootID = "user-attachments-collapse"
      const assistantID = "assistant-attachments-collapse"
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
      const imagePart = {
        id: "file-image",
        sessionID,
        messageID: assistantID,
        type: "attachment",
        mime: "image/svg+xml",
        filename: "meme.svg",
        url: "asset://meme",
      }
      const attachPart = {
        id: "tool-attach",
        sessionID,
        messageID: assistantID,
        type: "tool",
        callID: "call-attach",
        tool: "attach",
        state: {
          status: "completed",
          input: { file_path: "meme.svg" },
          output: "File delivered: meme.svg (1.0 KB)",
          title: "meme.svg",
          metadata: { display: { toolCard: "hidden" } },
          attachments: [imagePart],
          time: { start: 1, end: 2 },
        },
      }
      const mediaPart = {
        id: "tool-media",
        sessionID,
        messageID: assistantID,
        type: "tool",
        callID: "call-media",
        tool: "plugin__synergy-meme-plugin__generate_meme",
        state: {
          status: "completed",
          input: { prompt: "random meme" },
          output: "",
          title: "Meme",
          metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
          attachments: [{ ...imagePart, id: "file-image-media", filename: "meme-2.svg" }],
          time: { start: 1, end: 2 },
        },
      }
      const data = {
        session: [],
        session_status: { [sessionID]: { type: "idle" } },
        session_diff: { [sessionID]: [] },
        permission: { [sessionID]: [] },
        message: { [sessionID]: [rootMessage, assistantMessage] },
        part: {
          [rootID]: [],
          [assistantID]: [attachPart, mediaPart],
        },
      }
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
                    <DataProvider data={data} directory="/workspace" serverUrl="http://localhost">
                      <SessionTurn
                        sessionID={sessionID}
                        messageID={rootID}
                        rootMessage={rootMessage}
                        messages={[rootMessage, assistantMessage]}
                        lastUserMessageID={rootID}
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
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("SessionTurn delivered attachment collapse", () => {
  test("renders hidden-card attach deliveries in a default-expanded collapsible card", async () => {
    const cards = document.querySelectorAll('[data-component="collapsible"][data-variant="tool"]')
    expect(cards.length).toBe(1)

    const attachCard = cards[0] as HTMLElement
    expect(attachCard.hasAttribute("data-expanded")).toBe(true)

    const trigger = attachCard.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
    expect(trigger?.textContent).toContain("Add attachment")
    expect(trigger?.textContent).toContain("meme.svg")

    expect(attachCard.querySelector('[data-component="attachment-gallery"]')).toBeTruthy()

    trigger.click()
    await waitForUpdate()

    expect(attachCard.hasAttribute("data-expanded")).toBe(false)
    expect(attachCard.querySelector('[data-component="attachment-gallery"]')).toBeNull()
  })

  test("renders completed media-generation deliveries as a bare inline gallery", () => {
    const items = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="tool-attachments"]')
    expect(items.length).toBe(2)

    const attachItem = items[0] as HTMLElement
    expect(attachItem.querySelector('[data-component="collapsible"]')).toBeTruthy()

    const mediaItem = items[1] as HTMLElement
    expect(mediaItem.querySelector('[data-component="collapsible"]')).toBeNull()
    expect(mediaItem.querySelector('[data-slot="collapsible-trigger"]')).toBeNull()

    const gallery = mediaItem.querySelector('[data-component="attachment-gallery"]')
    expect(gallery).toBeTruthy()
    expect(mediaItem.querySelector('[data-component="attachment-card"]')).toBeTruthy()
  })
})
