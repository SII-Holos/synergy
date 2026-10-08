import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, ReasoningPart, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { ActivityBatch, ProcessReasoning } from "../../../src/components/activity-batch"
import type { ActivityBatchItem, ActivityDisplayMode } from "../../../src/components/session-turn-activity"
import { DataProvider } from "../../../src/context/data"
import { DialogProvider } from "../../../src/context/dialog"
import { ResourceOpenProvider } from "../../../src/context/resource-open"
import { setupI18n } from "../../../src/testing/i18n"

const sessionID = "activity-process"
const message = { id: "assistant-0", path: { root: "/project" } } as AssistantMessage
const [mode, setMode] = createSignal<ActivityDisplayMode>("balanced")
const [active, setActive] = createSignal(true)
const [following, setFollowing] = createSignal(true)
const [parts, setParts] = createSignal<ToolPart[]>([])
const [reasoning, setReasoning] = createSignal<ReasoningPart[]>([])
const [preview, setPreview] = createSignal(false)
const [expanded, setExpanded] = createStore<Record<string, boolean | undefined>>({})
const openedTools: string[] = []
const view = {
  getExpanded: (key: string) => expanded[key],
  setExpanded: (key: string, value: boolean) => setExpanded(key, value),
}

function tools(completed: number, running: number) {
  return Array.from(
    { length: completed + running },
    (_, index) =>
      ({
        id: `tool-${index}`,
        sessionID,
        messageID: `assistant-${index}`,
        type: "tool",
        tool: "bash",
        callID: `call-${index}`,
        workBrief: `Check project evidence ${index + 1}`,
        state:
          index < completed
            ? {
                status: "completed",
                input: { command: `echo ${index}` },
                output: String(index),
                title: "bash",
                metadata: {},
                time: { start: index, end: index + 1 },
              }
            : {
                status: "running",
                input: { command: `echo ${index}` },
                title: "bash",
                metadata: {},
                time: { start: index },
              },
      }) as ToolPart,
  )
}
const batch = (): ActivityBatchItem => ({
  kind: "activity-batch",
  key: "batch",
  message,
  steps: parts().map((part) => ({
    part,
    family: "execute",
    scopeKey: "project",
    icon: "terminal",
    title: part.workBrief!,
    state: part.state.status === "running" ? "running" : "done",
  })),
  facts: [{ family: "execute", count: parts().filter((part) => part.state.status === "completed").length }],
  state: parts().some((part) => part.state.status === "running") ? "running" : "done",
  failures: 0,
})
function reset(completed = 20, running = 1) {
  setExpanded({ batch: undefined, reasoning: false })
  setMode("balanced")
  setFollowing(true)
  setActive(true)
  setPreview(false)
  setParts(tools(completed, running))
  setReasoning(
    Array.from({ length: 3 }, (_, index) => ({
      id: `reasoning-${index}`,
      sessionID,
      messageID: `assistant-${index}`,
      type: "reasoning",
      text: `Reasoning from call ${index + 1}`,
      time: { start: index, end: index + 1 },
    })),
  )
}
reset()
const data = { session: [], session_diff: {}, message: {}, part: {} }
const requests = []
const runtime = {
  statusFor: () => ({ type: "busy" as const }),
  permissionsFor: () => requests,
  questionsFor: () => requests,
}
const i18n = setupI18n()
i18n.load("en", {})
i18n.load("zh-CN", {
  "activity.history.earlier": "先前的操作",
  "activity.history.later": "后续的操作",
  "session.reasoning.latest": "最新推理",
  "session.process.viewReasoning": "查看推理",
  "session.process.hideReasoning": "收起推理",
  "session.reasoning.segment": ["第 ", ["number"], " 段推理"],
  "session.reasoning.segments": [["count"], " 段推理"],
})
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <ResourceOpenProvider
          value={{
            openToolActivity: (target) => {
              openedTools.push(target.partID)
              return true
            },
            open: async () => ({ status: "cancelled" as const }),
          }}
        >
          <DataProvider data={data} runtime={runtime} directory="/project" serverUrl="http://localhost">
            <ActivityBatch
              batch={batch()}
              serverUrl="http://localhost"
              mode={mode()}
              active={active()}
              following={following()}
              view={view}
            />
            <ProcessReasoning
              entries={reasoning()}
              identity="reasoning"
              running={reasoning().at(-1)?.time.end === undefined}
              preview={preview()}
              view={view}
            />
          </DataProvider>
        </ResourceOpenProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.querySelector("#root")!,
)
globalThis.__activityProcessHarness = {
  reset,
  setMode,
  setActive,
  setFollowing,
  setTools: (completed: number, running = 1) => setParts(tools(completed, running)),
  openedTools,
  setReasoning: (entries: ReasoningPart[]) => setReasoning(entries),
  setPreview,
  setLocale: (locale: "en" | "zh-CN") => i18n.activate(locale),
}
