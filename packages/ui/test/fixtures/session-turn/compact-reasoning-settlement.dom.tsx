import { I18nProvider } from "@lingui/solid"
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
  text: "## Planning\nThinking through the request step by step.",
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
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, assistantMessage] },
  part: { [rootID]: [], [assistantID]: [reasoningPart, answerPart] },
})
// Session runtime state lives outside the Scope store; the view resolves
// it from this accessor bag.
const [runtimeState, setRuntimeState] = createStore({ status: { [sessionID]: { type: "busy" } } })
const NO_REQUESTS = []
const runtime = {
  statusFor: (id) => runtimeState.status[id],
  permissionsFor: () => NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}

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
              <DataProvider data={state} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
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
    setRuntimeState("status", sessionID, { type: "idle" })
    setState("message", sessionID, (messages) =>
      messages.map((m) => (m.id === assistantID ? { ...m, time: { ...m.time, completed: 5000 }, finish: "stop" } : m)),
    )
  },
}
