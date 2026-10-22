import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { DataProvider } from "../../../src/context/data.tsx"
import { DialogProvider } from "../../../src/context/dialog.tsx"
import { DiffComponentProvider } from "../../../src/context/diff.tsx"
import { MarkedProvider } from "../../../src/context/marked.tsx"
import { ResourceOpenProvider } from "../../../src/context/resource-open.tsx"
import { SessionTurn } from "../../../src/components/session-turn.tsx"
import { setupI18n } from "../../../src/testing/i18n.tsx"

const sessionID = "session-retry-header"
const rootID = "user-retry-header"
const assistantID = "assistant-retry-header"
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
// A retry removes the failed attempt's parts before it runs again, so a turn
// whose first attempt failed before emitting output is a root plus an empty
// assistant with no finish.
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
  time: { created: 2 },
}
const data = {
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, assistantMessage] },
  part: { [rootID]: [], [assistantID]: [] },
}
const NO_REQUESTS: never[] = []
const [status, setStatus] = createSignal<SessionStatus>({ type: "idle" })
const runtime = {
  statusFor: () => status(),
  permissionsFor: () => NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}
const EmptyDiff = () => null

const dispose = render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <DialogProvider>
        <ResourceOpenProvider
          value={{ openToolActivity: () => true, open: async () => ({ status: "cancelled" as const }) }}
        >
          <MarkedProvider>
            <DiffComponentProvider component={EmptyDiff}>
              <DataProvider data={data} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
                <SessionTurn
                  sessionID={sessionID}
                  messageID={rootID}
                  rootMessage={rootMessage}
                  messages={[rootMessage, assistantMessage]}
                  lastUserMessageID={rootID}
                  activityDisplay="minimal"
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

Object.assign(globalThis, { __retryHeaderHarness: { setStatus, dispose } })
