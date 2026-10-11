import "../../../src/styles/index.css"
import { I18nProvider } from "@lingui/solid"
import { createEffect, createRoot, createSignal, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import type { AssistantMessage, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { DataProvider, type Data } from "../../../src/context/data"
import { DialogProvider } from "../../../src/context/dialog"
import { DiffComponentProvider } from "../../../src/context/diff"
import { MarkedProvider } from "../../../src/context/marked"
import { ResourceOpenProvider } from "../../../src/context/resource-open"
import { readRenderState, RenderProvider, type RenderHost } from "../../../src/context/render"
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
const descriptor = () => {
  const { html, ...rest } = source
  return { ...rest, source: `asset://${String(count).padStart(16, "0")}.bin` }
}
const [metadata, setMetadata] = createSignal({ visual: descriptor(), visualState: state })
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
  setData(
    "part",
    assistant.id,
    reconcile([
      {
        id: "prt_render",
        sessionID: root.sessionID,
        messageID: assistant.id,
        type: "tool",
        tool: "render",
        callID: "call_render",
        state: {
          status: "completed",
          input: {},
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
        },
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
    if (rejectWrite) {
      throw new Error("Saving is unavailable")
    }
    if (update.revision !== state.revision) throw new Error("revision conflict")
    state = {
      revision: state.revision + 1,
      updatedAt: Date.now(),
      mutationID: update.mutationID,
      content: update.content,
    }
    writes++
    setMetadata({ visual: descriptor(), visualState: state })
    return state
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
      source = { ...source, id: crypto.randomUUID(), html, libraries }
      state = RenderArtifact.emptyState()
      count++
      setMetadata({ visual: descriptor(), visualState: state })
      return source.id
    },
    stats() {
      return { reads, writes, requests, images, state }
    },
    rejectWrites() {
      rejectWrite = true
    },
    remote(content: RenderArtifact.Content) {
      state = { revision: state.revision + 1, updatedAt: Date.now(), content }
      setMetadata({ visual: descriptor(), visualState: state })
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
