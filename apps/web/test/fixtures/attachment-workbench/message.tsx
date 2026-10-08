import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme/context"
import { Toast } from "@ericsanchezok/synergy-ui/toast"
import { UserMessageDisplay, createUserMessagePresentation } from "@ericsanchezok/synergy-ui/user-message-content"
import type { AttachmentPart, Part, UserMessage } from "@ericsanchezok/synergy-sdk"
import { ResourceOpenProvider } from "../../../src/context/resource-open"
import { WorkbenchPanelsProvider, useWorkbenchPanels } from "../../../src/context/workbench"
import { registerWorkbenchPanel } from "../../../src/plugin/registries/workbench-panel-registry"
import { AttachmentWorkbenchContent } from "../../../src/components/attachment-workbench/content"
import { WorkbenchSurface } from "../../../src/components/workspace/workbench-surface"
import { buildConversationRows } from "../../../src/components/session/conversation-rows"
import {
  draftTransitionKey,
  SessionTransitionProvider,
  useSessionTransition,
} from "../../../src/context/session-transition"
import { setCanonicalMessages } from "./message-host"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/index.css"
import "../../../src/components/session/conversation-rows.css"

const history = createMemoryHistory()
history.set({ value: "/fixture/session/session" })
const message: UserMessage = {
  id: "message",
  sessionID: "session",
  role: "user",
  time: { created: 1000 },
  agent: "general",
  model: { providerID: "fixture", modelID: "fixture" },
  isRoot: true,
  rootID: "message",
  visible: true,
}
const svg = (width: number, height: number, transparent = false) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${transparent ? `<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="gray"/>` : '<rect width="100%" height="100%" fill="gray"/>'}</svg>`,
  )
const image: AttachmentPart = {
  id: "image",
  sessionID: "session",
  messageID: "message",
  type: "attachment",
  mime: "image/svg+xml",
  filename: "portrait.svg",
  url: svg(80, 160),
}
const query = new URLSearchParams(location.search)
let fail = query.get("failure")
let release: (() => void) | undefined
function Fixture() {
  const theme = useTheme()
  const workbench = useWorkbenchPanels()
  const presentation = createUserMessagePresentation()
  const transitions = useSessionTransition()
  const [mounted, setMounted] = createSignal(true)
  const [resourcesMounted, setResourcesMounted] = createSignal(true)
  const [files, setFiles] = createSignal<Part[]>(
    query.has("mixed")
      ? [
          image,
          {
            ...image,
            id: "doc",
            mime: "text/plain",
            filename: "A very long document name.txt",
            url: "data:text/plain,example",
          },
        ]
      : query.has("many")
        ? Array.from({ length: 8 }, (_, index) => ({ ...image, id: `image-${index}`, filename: `image-${index}.svg` }))
        : [image],
  )
  const [body, setBody] = createSignal("Inspect this image")
  const [markdown, setMarkdown] = createSignal(
    query.has("inline") ? "" : "![Plot](asset://1111111111111111.png)\n\n[Report.txt](asset://2222222222222222.txt)",
  )
  const [streaming, setStreaming] = createSignal(true)
  const parts = () => [
    ...files(),
    { id: "text", messageID: "message", sessionID: "session", type: "text" as const, text: body() },
  ]
  setCanonicalMessages("session", query.has("preparing") ? [] : [message])
  if (query.has("preparing")) {
    transitions.prepareDraft(draftTransitionKey(location.origin, "fixture")).submit({
      text: body(),
      messageID: message.id,
      prompt: [],
      message,
      parts: parts(),
      serverUrl: location.origin,
    })
  }
  const register = () =>
    registerWorkbenchPanel({
      id: "attachment",
      pluginId: "builtin",
      label: "Attachment",
      icon: "file",
      surface: "side",
      cardinality: "multi",
      requiresSession: true,
      launchable: false,
      resolveTab: async (init) => {
        if (fail === "throw") throw new Error("Reader unavailable")
        if (fail === "empty") return undefined
        if (fail === "slow")
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return init
      },
      component: AttachmentWorkbenchContent,
    })
  let unregister: (() => void) | undefined
  onMount(() => {
    if (!query.has("unregistered")) unregister = register()
  })
  onCleanup(() => unregister?.())
  const rows = () =>
    buildConversationRows({
      timeline: [message],
      messagesFor: () => [],
      summaries: () =>
        parts().map((part) => ({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: part.type,
          preview: "",
          content: { bytes: 100, version: "fixture", complete: true },
        })),
      page: () => ({ hasMore: false }),
    }).filter((row) => row.kind === "body")
  Object.assign(window, {
    fixture: {
      setMarkdown,
      setStreaming,
      repair: () => {
        fail = null
        if (!unregister) unregister = register()
      },
      release: () => release?.(),
      navigate: () => history.set({ value: "/fixture/session/other" }),
      dispose: () => setResourcesMounted(false),
      cancel: () => transitions.clear(draftTransitionKey(location.origin, "fixture")),
      admit: () => setCanonicalMessages("session", [message]),
      tabs: () => workbench.surface("side").tabs(),
      remount: () => {
        setMounted(false)
        queueMicrotask(() => setMounted(true))
      },
      theme: (mode: "light" | "dark") => theme.setColorScheme(mode),
      single: (width: number, height: number) => setFiles([{ ...image, url: svg(width, height) }]),
      transparent: () => setFiles([{ ...image, url: svg(80, 160, true) }]),
      long: () => setBody("Long paragraph. ".repeat(100)),
      broken: () =>
        setFiles([{ ...image, url: "/missing-original", metadata: { thumbnail: { url: "/missing-thumbnail" } } }]),
    },
  })
  return (
    <Show when={resourcesMounted()}>
      <ResourceOpenProvider>
        <DataProvider
          data={{
            session: [],
            session_diff: {},
            message: { session: [message] },
            get part() {
              return { message: parts() }
            },
          }}
          serverUrl={location.origin}
          directory={null}
        >
          <div class="session-workbench-pane" style={{ height: "100dvh", display: "flex" }}>
            <div class="session-content-column" style={{ "min-width": "0", flex: "1", padding: "16px" }}>
              <Show when={query.has("markdown")}>
                <Markdown text={markdown()} streaming={streaming()} />
              </Show>
              <For each={mounted() ? rows() : []}>
                {(row) => (
                  <div
                    class="conversation-display-row"
                    data-message-role="user"
                    data-row-kind="body"
                    data-message-end={row.after ? "" : undefined}
                  >
                    <UserMessageDisplay
                      message={message}
                      parts={parts().filter((part) => row.parts.some((summary) => summary.id === part.id))}
                      variant="turn-bubble"
                      showMetadata={row.after}
                      presentation={presentation}
                    />
                  </div>
                )}
              </For>
            </div>
            <WorkbenchSurface surface="side" />
          </div>
        </DataProvider>
        <Toast.Region limit={5} swipeDirection="right" pauseOnInteraction={true} />
      </ResourceOpenProvider>
    </Show>
  )
}
render(
  () => (
    <I18nProvider i18n={setupI18n({ locale: "en" })}>
      <ThemeProvider>
        <DialogProvider>
          <MarkedProvider>
            <MemoryRouter history={history}>
              <Route
                path="/:dir/session/:id"
                component={() => (
                  <SessionTransitionProvider>
                    <WorkbenchPanelsProvider>
                      <Fixture />
                    </WorkbenchPanelsProvider>
                  </SessionTransitionProvider>
                )}
              />
            </MemoryRouter>
          </MarkedProvider>
        </DialogProvider>
      </ThemeProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
