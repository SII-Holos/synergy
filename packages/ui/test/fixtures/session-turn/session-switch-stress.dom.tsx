import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { ErrorBoundary } from "solid-js"
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

const sessionID = "session-stress"
const rootID = "user-stress"
const doneID = "assistant-stress"

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
const secondAssistant = { ...baseAssistant, id: "assistant-stress-2", time: { created: 4, completed: 5 } }

// Replacement buckets must carry structurally complete messages: the
// render chain reads time/role/rootID off them. In production these
// always exist on store messages; the test targets *missing buckets*
// (the session-switch intermediate state), not malformed objects.
const buildUser = (id) => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: TEST_AGENT_NAME,
  model: { providerID: "provider", modelID: "model" },
  isRoot: true,
  rootID: id,
  visible: true,
})
const buildAssistant = (id) => ({
  ...baseAssistant,
  id,
  time: { created: 2, completed: 3 },
})

const doneTextPart = { id: "part-stress", sessionID, messageID: doneID, type: "text", text: "Stress answer" }

const runtimeSeed = {
  sessionStatus: { [sessionID]: { type: "busy" } },
  permissions: { [sessionID]: [] },
}
const [store, setStore] = createStore({
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, doneAssistant] },
  part: { [doneID]: [doneTextPart] },
})
// Session runtime state lives outside the Scope store, so the view reads
// it from this separately-mutated accessor bag.
const [runtimeState, setRuntimeState] = createStore(runtimeSeed)
const NO_REQUESTS = []
const runtime = {
  statusFor: (id) => runtimeState.sessionStatus[id],
  permissionsFor: (id) => runtimeState.permissions[id] ?? NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}

setExternalToolLookup(() => undefined)
const resourceController = {
  open: async () => ({ status: "cancelled" as const }),
}
const EmptyDiff = () => null

// A render error inside SessionTurn (its own memo chain) escapes the
// per-item TimelineDisplay boundaries and would bubble here. Count it so
// the test can assert zero errors across rapid switch mutations.
let boundaryErrors = 0
let windowErrors = 0
window.addEventListener("error", () => {
  windowErrors++
})

const fullState = () => ({
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, doneAssistant] },
  part: { [doneID]: [doneTextPart] },
})
const emptyState = () => ({
  session: [],
  session_diff: {},
  message: {},
  part: {},
})

render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <DialogProvider>
        <ResourceOpenProvider value={resourceController}>
          <MarkedProvider>
            <DiffComponentProvider component={EmptyDiff}>
              <DataProvider data={store} runtime={runtime} directory="/workspace" serverUrl="http://localhost">
                <ErrorBoundary
                  fallback={(err) => {
                    boundaryErrors++
                    console.error("[stress] boundary caught", err)
                    return null
                  }}
                >
                  <SessionTurn
                    sessionID={sessionID}
                    messageID={rootID}
                    rootMessage={rootMessage}
                    messages={store.message[sessionID] ?? []}
                    lastUserMessageID={rootID}
                    activityDisplay="balanced"
                  />
                </ErrorBoundary>
              </DataProvider>
            </DiffComponentProvider>
          </MarkedProvider>
        </ResourceOpenProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.querySelector("#root"),
)

globalThis.__sessionSwitchStressHarness = {
  replaceMessageBucket: (sid, messages) => setStore("message", sid, messages),
  replacePartBucket: (mid, parts) => setStore("part", mid, parts),
  replacePermissionBucket: (sid, permissions) => setRuntimeState("permissions", sid, permissions),
  replaceSessionStatus: (sid, status) => setRuntimeState("sessionStatus", sid, status),
  replaceWithFreshObjects: () => {
    setStore("message", sessionID, [buildUser(rootID), buildAssistant(doneID)])
    setStore("part", doneID, [doneTextPart])
    setRuntimeState("permissions", sessionID, [])
    setRuntimeState("sessionStatus", sessionID, { type: "busy" })
  },
  replaceMessagesGrown: () => {
    // Grows the display window (a second assistant becomes the latest)
    // while simultaneously clearing the part buckets: the projection
    // source is replaced in the same batch, so any stale index into
    // displayItemProjections transiently lands on a missing/out-of-range
    // slot. The ?.() ?? [] guard must degrade that to an empty array
    // instead of throwing.
    setStore("message", sessionID, [buildUser(rootID), buildAssistant(doneID), buildAssistant("assistant-stress-2")])
    setStore("part", doneID, undefined)
    setRuntimeState("permissions", sessionID, undefined)
  },
  clearAllBuckets: () => {
    setStore(emptyState())
    setRuntimeState({ sessionStatus: {}, permissions: {} })
  },
  restoreBuckets: () => {
    setStore(fullState())
    setRuntimeState(runtimeSeed)
  },
  getErrors: () => boundaryErrors + windowErrors,
}
