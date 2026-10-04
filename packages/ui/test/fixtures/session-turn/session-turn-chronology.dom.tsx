import { I18nProvider } from "@lingui/solid"
import { createSignal, For } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DataProvider } from "../../../src/context/data.tsx"
import { DialogProvider } from "../../../src/context/dialog.tsx"
import { DiffComponentProvider } from "../../../src/context/diff.tsx"
import { MarkedProvider } from "../../../src/context/marked.tsx"
import { ResourceOpenProvider } from "../../../src/context/resource-open.tsx"
import { SessionTurn } from "../../../src/components/session-turn.tsx"
import { setupI18n } from "../../../src/testing/i18n.tsx"
import { setExternalMessageSlotLookup } from "../../../src/components/message-slots.tsx"

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
  tool: "mcp__scholight__search_papers",
  state: {
    status: "completed",
    input: { query: "checkpoint convergence" },
    output: "Read example.ts",
    title: "Read example.ts",
    metadata: {},
    time: { start: 1, end: 2 },
  },
}
const secondToolPart = {
  ...toolPart,
  tool: "mcp__scholight__extract_url",
  state: { ...toolPart.state, input: { url: "https://example.com/paper" } },
  id: "tool-activity-switch-second",
  messageID: secondAssistantID,
  callID: "call-activity-switch-second",
}
const failedToolPart = {
  id: "tool-activity-switch-failed",
  sessionID,
  messageID: secondAssistantID,
  type: "tool",
  callID: "call-activity-switch-failed",
  tool: "bash",
  workBrief: "Inspect missing.json without changing files.",
  state: {
    status: "error",
    input: { command: "cat missing.json" },
    error: "missing.json does not exist",
    metadata: {},
    time: { start: 3, end: 4 },
  },
}
const answerPart = {
  id: "answer-activity-switch",
  sessionID,
  messageID: assistantID,
  type: "text",
  text: "Representative answer survives mode switches.",
}
const [data, setData] = createStore({
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, assistantMessage, secondAssistantMessage] },
  part: {
    [rootID]: [],
    [assistantID]: [toolPart],
    [secondAssistantID]: [secondToolPart, failedToolPart, { ...answerPart, messageID: secondAssistantID }],
  },
})
// Session runtime state lives outside the Scope store; the view resolves
// it from this accessor bag.
const NO_REQUESTS = []
const runtime = {
  statusFor: () => ({ type: stage() >= 8 ? "idle" : "busy" }),
  permissionsFor: () => NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}
const openedTools = []
const resourceController = {
  openToolActivity: (target) => {
    openedTools.push(target)
    return true
  },
  open: () => false,
  openAttachment: () => false,
  resolveWorkspacePath: (value) => value,
  openWorkspaceSource: () => false,
}
const EmptyDiff = () => null
const [mode, setMode] = createSignal("balanced")
const [segmented, setSegmented] = createSignal(false)
const [preview, setPreview] = createSignal(false)
const [stage, setStage] = createSignal(0)
const [expanded, setExpanded] = createStore({})
const [executionState, setExecutionState] = createSignal()
const SlotProbe = (props) => <span data-test-slot={props.slot} data-test-message={props.messageId} />
setExternalMessageSlotLookup((slot) =>
  ["message.before", "message.actions", "message.after"].includes(slot)
    ? [{ id: "probe-" + slot, component: SlotProbe }]
    : [],
)

const i18n = setupI18n()
i18n.load("en", {})
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <ResourceOpenProvider value={resourceController}>
          <MarkedProvider>
            <DiffComponentProvider component={EmptyDiff}>
              <DataProvider data={data} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
                <For each={segmented() ? ["header", "first", "second", "answer", "footer"] : ["whole"]}>
                  {(segment) => (
                    <SessionTurn
                      segment={
                        segment === "whole"
                          ? undefined
                          : {
                              user: false,
                              footer: segment === "footer",
                              before: true,
                              after: true,
                              processHeader: segment === "header",
                              processBody: segment === "first" || segment === "second",
                              process: {
                                hasContent: true,
                                hasTurnContent: stage() > 0,
                                working: stage() < 8,
                                open: expanded[`turn-process:${rootID}`] ?? true,
                              },
                              parts:
                                segment === "first"
                                  ? data.part[assistantID]
                                  : segment === "second"
                                    ? data.part[secondAssistantID].filter((p) => p.id !== "final")
                                    : segment === "answer"
                                      ? data.part[secondAssistantID].filter((p) => p.id === "final")
                                      : [],
                            }
                      }
                      sessionID={sessionID}
                      messageID={rootID}
                      rootMessage={rootMessage}
                      messages={data.message[sessionID]}
                      lastUserMessageID={rootID}
                      activityDisplay={mode()}
                      compactReasoning={preview()}
                      executionState={executionState()}
                      following
                      activityView={{
                        getExpanded: (key) => expanded[key],
                        setExpanded: (key, value) => setExpanded(key, value),
                      }}
                    >
                      <span id="activity-switch-sentinel" hidden>
                        stable
                      </span>
                    </SessionTurn>
                  )}
                </For>
              </DataProvider>
            </DiffComponentProvider>
          </MarkedProvider>
        </ResourceOpenProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.querySelector("#root"),
)

function move(next) {
  setStage(next)
  setExecutionState({
    rootID,
    status: next >= 8 ? "completed" : "running",
    startedAt: 1,
    endedAt: next >= 8 ? 8 : undefined,
    stoppedAt: [],
  })
  const first = {
    ...assistantMessage,
    time: { created: 1, completed: next >= 4 ? 4 : undefined },
    finish: next >= 4 ? "tool-calls" : undefined,
  }
  const second = {
    ...secondAssistantMessage,
    time: { created: 5, completed: next >= 8 ? 8 : undefined },
    finish: next >= 8 ? "stop" : undefined,
  }
  const reason = (id, messageID, ended) => ({
    id,
    sessionID,
    messageID,
    type: "reasoning",
    text: id === "initial" ? "Initial private reasoning" : "Later private reasoning",
    time: { start: 1, end: ended ? 2 : undefined },
  })
  const tool = (id, messageID, ended) => ({
    ...toolPart,
    id,
    messageID,
    tool: "bash",
    workBrief: `Inspect evidence ${id}`,
    state: ended ? toolPart.state : { ...toolPart.state, status: "running", time: { start: 1 } },
  })
  setData("message", sessionID, [rootMessage, ...(next ? [first] : []), ...(next >= 4 ? [second] : [])])
  setData("part", assistantID, [
    ...(next >= 1 ? [reason("initial", assistantID, next >= 2)] : []),
    ...(next >= 2 ? [{ ...answerPart, text: "I will inspect the project evidence." }] : []),
    ...(next >= 3 ? [tool("tool-1", assistantID, next >= 4)] : []),
  ])
  setData("part", secondAssistantID, [
    ...(next >= 5 ? [reason("later", secondAssistantID, next >= 6)] : []),
    ...(next >= 6 ? [tool("tool-2", secondAssistantID, next >= 7)] : []),
    ...(next >= 7
      ? [{ ...answerPart, id: "final", messageID: secondAssistantID, text: "Both evidence checks passed." }]
      : []),
  ])
}
move(0)
globalThis.__chronologyHarness = {
  move,
  setMode,
  setPreview,
  setSegmented,
  addCompaction: (state = "committed") => {
    move(8)
    setData("message", sessionID, 1, {
      ...assistantMessage,
      mode: "compaction",
      agent: "compaction",
      metadata: { compactionAttempt: { state } },
      time: { created: 1, completed: state === "running" ? undefined : 2 },
      error: state === "failed" ? { name: "UnknownError", data: { message: "Provider unavailable" } } : undefined,
    })
    setData(
      "part",
      assistantID,
      state !== "committed"
        ? []
        : [
            {
              id: "recovery",
              sessionID,
              messageID: assistantID,
              type: "compaction_recovery",
              summary: "Durable summary",
              mechanical: false,
              validated: true,
            },
          ],
    )
  },
  setProgress: (value) => setData("part", assistantID, 1, "text", value),
  reset: () => {
    for (const key of Object.keys(expanded)) setExpanded(key, undefined)
    setSegmented(false)
    setMode("balanced")
    setPreview(false)
    move(0)
  },
}
