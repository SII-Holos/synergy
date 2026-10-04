import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { I18nProvider } from "@lingui/solid"
import { render } from "solid-js/web"
import { DataProvider } from "../../../src/context/data.tsx"
import { DialogProvider } from "../../../src/context/dialog.tsx"
import { DiffComponentProvider } from "../../../src/context/diff.tsx"
import { MarkedProvider } from "../../../src/context/marked.tsx"
import { ResourceOpenProvider } from "../../../src/context/resource-open.tsx"
import { SessionTurn } from "../../../src/components/session-turn.tsx"
import { setupI18n } from "../../../src/testing/i18n.tsx"

const sessionID = "session-attachments-collapse"
const rootID = "user-attachments-collapse"
const assistantID = "assistant-attachments-collapse"
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
const imagePart = {
  id: "file-image",
  sessionID,
  messageID: assistantID,
  type: "attachment",
  mime: "image/svg+xml",
  filename: "meme.svg",
  url: "asset://meme",
}
const attachPart = {
  id: "tool-attach",
  sessionID,
  messageID: assistantID,
  type: "tool",
  callID: "call-attach",
  tool: "attach",
  state: {
    status: "completed",
    input: { file_path: "meme.svg" },
    output: "File delivered: meme.svg (1.0 KB)",
    title: "meme.svg",
    metadata: { display: { toolCard: "hidden" } },
    attachments: [imagePart],
    time: { start: 1, end: 2 },
  },
}
const mediaPart = {
  id: "tool-media",
  sessionID,
  messageID: assistantID,
  type: "tool",
  callID: "call-media",
  tool: "plugin__synergy-meme-plugin__generate_meme",
  state: {
    status: "completed",
    input: { prompt: "random meme" },
    output: "",
    title: "Meme",
    metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
    attachments: [{ ...imagePart, id: "file-image-media", filename: "meme-2.svg" }],
    time: { start: 1, end: 2 },
  },
}
const data = {
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [rootMessage, assistantMessage] },
  part: {
    [rootID]: [],
    [assistantID]: [attachPart, mediaPart],
  },
}
// Session runtime state lives outside the Scope store; the view resolves
// it from this accessor bag.
const NO_REQUESTS = []
const runtime = {
  statusFor: () => ({ type: "idle" }),
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
                  messages={[rootMessage, assistantMessage]}
                  lastUserMessageID={rootID}
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
