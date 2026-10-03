import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { I18nProvider } from "@lingui/solid"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { DataProvider } from "../../../src/context/data.tsx"
import { DialogProvider } from "../../../src/context/dialog.tsx"
import { DiffComponentProvider } from "../../../src/context/diff.tsx"
import { MarkedProvider } from "../../../src/context/marked.tsx"
import { ResourceOpenProvider } from "../../../src/context/resource-open.tsx"
import { SessionTurn } from "../../../src/components/session-turn.tsx"
import { setExternalToolLookup } from "../../../src/components/tool-registry-lazy.ts"
import { setupI18n } from "../../../src/testing/i18n.tsx"

const sessionID = "session-projection-memoization"
const rootID = "user-projection-memoization"
const doneID = "assistant-done"
const streamID = "assistant-stream"

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
const baseAssistant = {
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
}
const doneAssistant = { ...baseAssistant, id: doneID, time: { created: 2, completed: 3 } }
const streamAssistant = { ...baseAssistant, id: streamID, time: { created: 4 } }

const doneTextPart = { id: "part-done", sessionID, messageID: doneID, type: "text", text: "Done answer" }
const doneToolPart = {
  id: "part-done-tool",
  sessionID,
  messageID: doneID,
  type: "tool",
  callID: "call-done-tool",
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
const streamTextPart = { id: "part-stream", sessionID, messageID: streamID, type: "text", text: "stream " }

const [store, setStore] = createStore({
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, doneAssistant, streamAssistant] },
  part: { [doneID]: [doneTextPart, doneToolPart], [streamID]: [streamTextPart] },
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

// Balanced activity projection resolves the external tool renderer for
// every ordinary tool part — twice per projection pass (group-key scan
// and main loop) — so re-projecting the settled message advances this
// counter by exactly two: a deterministic, DOM-independent signal for
// projection work.
let toolLookups = 0
setExternalToolLookup(() => {
  toolLookups++
  return undefined
})
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
              <DataProvider data={store} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
                <SessionTurn
                  sessionID={sessionID}
                  messageID={rootID}
                  rootMessage={rootMessage}
                  messages={store.message[sessionID]}
                  lastUserMessageID={rootID}
                  activityDisplay="balanced"
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

globalThis.__projectionMemoizationHarness = {
  setStreamText: (text) => setStore("part", streamID, 0, "text", text),
  setSessionStatus: (status) => setRuntimeState("status", sessionID, status),
  completeStream: () => setStore("message", sessionID, 2, "time", "completed", 5),
  getToolLookups: () => toolLookups,
}
