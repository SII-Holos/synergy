import "../../../src/styles/index.css"
import { I18nProvider } from "@lingui/solid"
import { batch, createEffect, createRoot, createSignal, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import type { AssistantMessage, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { DataProvider, type Data } from "../../../src/context/data"
import { DialogProvider } from "../../../src/context/dialog"
import { DiffComponentProvider } from "../../../src/context/diff"
import { MarkedProvider } from "../../../src/context/marked"
import { ResourceOpenProvider } from "../../../src/context/resource-open"
import { readRenderState, RenderProvider, RenderStateConflict, type RenderHost } from "../../../src/context/render"
import { SessionTurn } from "../../../src/components/session-turn"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { setupI18n } from "../../../src/testing/i18n"

let count = 0
let source: RenderArtifact.Source = {
  format: "synergy.visual",
  version: 1,
  id: crypto.randomUUID(),
  mode: "interactive",
  title: "Worker timing",
  layout: "wide",
  libraries: [],
  html: "<p>Ready</p>",
}
let state = RenderArtifact.emptyState()
let reads = 0,
  writes = 0
const requests: string[] = []
const images: Array<string | undefined> = []
let holdFollowUp = false
let rejectWrite = false
let releaseFollowUp: (() => void) | undefined
let holdWrite = false
let releaseWrite: (() => void) | undefined
const descriptor = () => {
  const { html, ui, ...rest } = source
  return { ...rest, source: `asset://${String(count).padStart(16, "0")}.bin` }
}
const [callID, setCallID] = createSignal("prt_render0")
let conflict = false
const [input, setInput] = createStore<Record<string, unknown>>({})
const [status, setStatus] = createSignal<"completed" | "generating" | "running">("completed")
const [metadata, setMetadata] = createSignal({ visual: descriptor(), visualState: state })
const [visible, setVisible] = createSignal(true)
const root: UserMessage = {
  id: "msg_root",
  sessionID: "ses_render",
  role: "user",
  time: { created: 1 },
  agent: TEST_AGENT_NAME,
  model: { providerID: "fixture", modelID: "fixture" },
  isRoot: true,
  rootID: "msg_root",
}
const assistant: AssistantMessage = {
  id: "msg_render",
  sessionID: root.sessionID,
  role: "assistant",
  parentID: root.id,
  rootID: root.id,
  agent: TEST_AGENT_NAME,
  mode: "test",
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "fixture",
  providerID: "fixture",
  time: { created: 1, completed: 2 },
  finish: "stop",
}
const messages = [root, assistant]
const [data, setData] = createStore<Data>({
  session: [],
  session_diff: {},
  message: { [root.sessionID]: messages },
  part: { [root.id]: [], [assistant.id]: [] },
})
function syncMetadata() {
  const current = metadata()
  if (!visible()) {
    setData("part", assistant.id, [])
    return
  }
  setData(
    "part",
    assistant.id,
    reconcile([
      {
        id: callID(),
        sessionID: root.sessionID,
        messageID: assistant.id,
        type: "tool",
        tool: "render",
        callID: "call_render",
        state:
          status() === "completed"
            ? {
                status: "completed",
                input: JSON.parse(JSON.stringify(input)),
                output: "Saved visual source",
                title: current.visual.title,
                metadata: structuredClone(current),
                time: { start: 1, end: 2 },
                attachments: [
                  {
                    id: "prt_source",
                    sessionID: root.sessionID,
                    messageID: assistant.id,
                    type: "attachment",
                    mime: RenderArtifact.MIME,
                    filename: "visual.synergy.json",
                    url: current.visual.source,
                    presentation: { purpose: "deliverable", renderer: "file" },
                  },
                ],
              }
            : status() === "generating"
              ? {
                  status: "generating",
                  input: {},
                  raw: JSON.stringify(input).slice(0, -1),
                  charsReceived: JSON.stringify(input).length - 1,
                  time: { start: 1 },
                }
              : { status: "running", input: JSON.parse(JSON.stringify(input)), time: { start: 1 } },
      },
    ]),
  )
}
const host: RenderHost = {
  observe(target, update) {
    return createRoot((dispose) => {
      createEffect(() => {
        const part = data.part[target.messageID]?.find((part) => part.id === target.partID)
        if (part?.type !== "tool" || part.state.status !== "completed") return
        const current = readRenderState(part.state.metadata)
        untrack(() => update(current))
      })
      return dispose
    })
  },
  async read() {
    reads++
    return { source, state }
  },
  async write(target, update) {
    if (conflict) {
      conflict = false
      state = {
        revision: state.revision + 1,
        updatedAt: Date.now(),
        content: { modelContent: { parameters: { seats: 12 } } },
      }
      setMetadata({ visual: descriptor(), visualState: state })
      throw new RenderStateConflict("Another view changed the estimate", state)
    }
    if (rejectWrite) {
      throw new Error("Saving is unavailable")
    }
    if (update.revision !== state.revision) throw new Error("revision conflict")
    const acknowledgedRevision = state.revision + 1
    state = {
      revision: state.revision + 1,
      updatedAt: Date.now(),
      mutationID: update.mutationID,
      content: update.content,
    }
    writes++
    setMetadata({ visual: descriptor(), visualState: state })
    if (holdWrite)
      await new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
    return {
      revision: acknowledgedRevision,
      updatedAt: Date.now(),
      mutationID: update.mutationID,
      content: update.content,
    }
  },
  async followUp(target, visual, input) {
    RenderArtifact.FollowUp.parse(input)
    requests.push(input.text)
    images.push(input.image)
    if (holdFollowUp)
      await new Promise<void>((resolve) => {
        releaseFollowUp = resolve
      })
    return "cancelled"
  },
}
const i18n = setupI18n()
i18n.load("zh-CN", { "tool.render.reset": "重置" })
Object.assign(window, {
  __renderTest: {
    setup(html: string, libraries: RenderArtifact.Source["libraries"] = []) {
      rejectWrite = false
      source = { ...source, id: crypto.randomUUID(), html, libraries, ui: undefined, renderer: undefined }
      state = RenderArtifact.emptyState()
      count++
      batch(() => {
        setInput(reconcile({}))
        setStatus("completed")
        setCallID(`prt_render${count}`)
        setMetadata({ visual: descriptor(), visualState: state })
      })
      return source.id
    },
    setupUI(ui: RenderArtifact.Source["ui"], streaming = false) {
      rejectWrite = false
      count++
      source = { ...source, id: crypto.randomUUID(), renderer: "native", ui, html: "<p>Fallback</p>" }
      state = RenderArtifact.emptyState()
      batch(() => {
        setCallID(`prt_render${count}`)
        setInput(reconcile({ ui }))
        setStatus(streaming ? "generating" : "completed")
        setMetadata({ visual: descriptor(), visualState: state })
      })
    },
    stream(ui: unknown, complete = false) {
      batch(() => {
        setInput(reconcile({ ui }))
        if (complete) {
          source = { ...source, ui: ui as RenderArtifact.Source["ui"] }
          setMetadata({ visual: descriptor(), visualState: state })
          setStatus("completed")
        }
      })
    },
    prepare() {
      batch(() => {
        setInput(reconcile({}))
        setStatus("running")
      })
    },
    visible(visible: boolean) {
      setVisible(visible)
    },
    stats() {
      return { reads, writes, requests, images, state }
    },
    conflictWrites() {
      conflict = true
    },
    rejectWrites() {
      rejectWrite = true
    },
    retryWrites() {
      rejectWrite = false
    },
    remote(content: RenderArtifact.Content) {
      state = { revision: state.revision + 1, updatedAt: Date.now(), content }
      setMetadata({ visual: descriptor(), visualState: state })
    },
    holdWrites() {
      holdWrite = true
    },
    releaseWrites() {
      holdWrite = false
      releaseWrite?.()
    },
    locale(locale: string) {
      i18n.activate(locale)
    },
    holdFollowUp() {
      holdFollowUp = true
    },
    releaseFollowUp() {
      holdFollowUp = false
      releaseFollowUp?.()
    },
  },
})
render(() => {
  createEffect(syncMetadata)
  return (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <RenderProvider value={host}>
          <ResourceOpenProvider value={{ open: async () => ({ status: "cancelled" }) }}>
            <MarkedProvider>
              <DiffComponentProvider component={() => null}>
                <DataProvider data={data} directory="/workspace" serverUrl="http://localhost">
                  <SessionTurn
                    sessionID={root.sessionID}
                    messageID={root.id}
                    rootMessage={root}
                    messages={messages}
                    lastUserMessageID={root.id}
                  />
                </DataProvider>
              </DiffComponentProvider>
            </MarkedProvider>
          </ResourceOpenProvider>
        </RenderProvider>
      </DialogProvider>
    </I18nProvider>
  )
}, document.getElementById("root")!)
