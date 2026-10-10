import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
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
  agent: TEST_AGENT_NAME,
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
  agent: TEST_AGENT_NAME,
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
const data = {
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, assistantMessage, secondAssistantMessage] },
  part: {
    [rootID]: [],
    [assistantID]: [toolPart],
    [secondAssistantID]: [secondToolPart, failedToolPart, { ...answerPart, messageID: secondAssistantID }],
  },
}
// Session runtime state lives outside the Scope store; the view resolves
// it from this accessor bag.
const NO_REQUESTS = []
const [sessionPaused, setSessionPaused] = createSignal(false)
const runtime = {
  statusFor: () => (sessionPaused() ? { type: "paused", reason: "aborted" } : { type: "idle" }),
  permissionsFor: () => NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}
const openedTools = []
const resourceController = {
  openToolActivity: (target) => {
    openedTools.push(target)
    return true
  },
  open: async () => ({ status: "cancelled" as const }),
}
const EmptyDiff = () => null
const [mode, setMode] = createSignal("minimal")
const [executionState, setExecutionState] = createSignal()
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
              <DataProvider data={data} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
                <SessionTurn
                  sessionID={sessionID}
                  messageID={rootID}
                  rootMessage={rootMessage}
                  messages={[rootMessage, assistantMessage, secondAssistantMessage]}
                  lastUserMessageID={rootID}
                  activityDisplay={mode()}
                  executionState={executionState()}
                  executionSummary={sessionPaused() ? { status: "running", elapsedMs: 3000 } : undefined}
                >
                  <span id="activity-switch-sentinel" hidden>
                    stable
                  </span>
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

globalThis.__activitySwitchHarness = {
  setSessionPaused,
  setMode,
  openedTools,
  setExecutionStatus: (status) =>
    setExecutionState({ rootID, status, startedAt: 1, endedAt: 4, stoppedAt: status === "stopped" ? [4] : [] }),
}
