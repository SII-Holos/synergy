import { I18nProvider } from "@lingui/solid"
import { batch, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, Part, TurnExecutionState, UserMessage } from "@ericsanchezok/synergy-sdk"
import { DataProvider } from "../../../src/context/data"
import { DialogProvider } from "../../../src/context/dialog"
import { DiffComponentProvider } from "../../../src/context/diff"
import { MarkedProvider } from "../../../src/context/marked"
import { ViewActivityProvider } from "../../../src/context/view-activity"
import { ConversationMotionProvider } from "../../../src/components/conversation-motion"
import { SessionTurn } from "../../../src/components/session-turn"
import type { TurnExecutionSummary } from "../../../src/components/execution-completion"
import { setupI18n } from "../../../src/testing/i18n"
import { applyThemeToDocument } from "../../../src/theme/application"
import { resolveTheme } from "../../../src/theme/resolve"
import { synergyTheme } from "../../../src/theme/default-themes"

const sessionID = "completion-session"
const rootID = "completion-root"
const assistantID = "completion-answer"
const query = new URLSearchParams(location.search)
const root: UserMessage = {
  id: rootID,
  sessionID,
  role: "user",
  agent: "test",
  time: { created: 1 },
  model: { providerID: "test", modelID: "test" },
  rootID,
  isRoot: true,
  visible: true,
}
const answer: AssistantMessage = {
  id: assistantID,
  sessionID,
  parentID: rootID,
  rootID,
  role: "assistant",
  agent: "test",
  mode: "test",
  modelID: "test",
  providerID: "test",
  time: { created: 2 },
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const text: Part = {
  id: "completion-text",
  messageID: assistantID,
  sessionID,
  type: "text",
  text: query.has("list")
    ? "Completed the checks.\n\n- Input stays stable\n- Draft remains saved\n- Light and dark share the same color roles"
    : "The reply keeps its **formatted text** and wraps across several lines in a narrow conversation.\n\nThe final paragraph also wraps, with enough ordinary prose to put the actual **last reply words** on a different line.",
}
const [data, setData] = createStore({
  session: [],
  session_diff: { [sessionID]: [] },
  message: { [sessionID]: [root, answer] },
  part: { [rootID]: [], [assistantID]: [text] },
})
const [state, setState] = createSignal<TurnExecutionState>({ rootID, status: "running", startedAt: 1, stoppedAt: [] })
const [summary, setSummary] = createSignal<TurnExecutionSummary>()
const [revision, setRevision] = createSignal(0)
const [ready, setReady] = createSignal(true)
const [active, setActive] = createSignal(true)
const [following, setFollowing] = createSignal(true)
const [mount, setMount] = createSignal(0)
const [mounted, setMounted] = createSignal(true)
const segmented = query.has("segmented")
let opened = 0
const tokens = resolveTheme(synergyTheme).light
applyThemeToDocument(document, tokens, "light", "synergy")

render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <DialogProvider>
        <MarkedProvider>
          <DiffComponentProvider component={() => null}>
            <DataProvider
              data={data}
              runtime={{
                statusFor: () => (state().status === "running" ? { type: "busy" } : { type: "idle" }),
                permissionsFor: () => [],
                questionsFor: () => [],
              }}
              directory="/workspace"
              serverUrl="http://localhost"
            >
              <ViewActivityProvider active={active}>
                <ConversationMotionProvider liveRevision={revision} ready={ready}>
                  <div
                    data-conversation-viewport
                    data-scroll-viewport="vertical"
                    style={{ height: "560px", overflow: "auto" }}
                  >
                    <div data-component={segmented ? "virtual-conversation-rows" : undefined}>
                      <Show when={mounted()}>
                        <For each={[mount()]}>
                          {() => (
                            <For each={segmented ? ["answer", "footer"] : ["whole"]}>
                              {(segment) => (
                                <SessionTurn
                                  sessionID={sessionID}
                                  messageID={rootID}
                                  rootMessage={root}
                                  messages={data.message[sessionID]}
                                  lastUserMessageID={rootID}
                                  following={following()}
                                  connected={ready()}
                                  executionState={state()}
                                  executionSummary={summary()}
                                  onExecutionDetails={() => opened++}
                                  segment={
                                    segment === "whole"
                                      ? undefined
                                      : {
                                          user: false,
                                          footer: segment === "footer",
                                          parts: segment === "answer" ? [text] : [],
                                          before: true,
                                          after: true,
                                          processBody: false,
                                          contentMessageID: segment === "answer" ? assistantID : undefined,
                                        }
                                  }
                                />
                              )}
                            </For>
                          )}
                        </For>
                      </Show>
                    </div>
                  </div>
                </ConversationMotionProvider>
              </ViewActivityProvider>
            </DataProvider>
          </DiffComponentProvider>
        </MarkedProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)

Object.assign(window, {
  completionRibbonFixture: {
    live: () => setRevision((value) => value + 1),
    finish: (status: TurnExecutionState["status"] = "completed") =>
      batch(() => {
        setData("message", sessionID, 1, { ...answer, time: { created: 2, completed: 3 }, finish: "stop" })
        setState({ rootID, status, startedAt: 1, endedAt: 3, stoppedAt: [] })
      }),
    setReady,
    setActive,
    setFollowing,
    setSummary,
    clearReply: () => setData("part", assistantID, []),
    remount: () => setMount((value) => value + 1),
    unmount: () => setMounted(false),
    opened: () => opened,
    retheme: () =>
      applyThemeToDocument(
        document,
        { ...tokens, "brand-ribbon-start": tokens["brand-ribbon-end"] },
        "light",
        "custom",
      ),
  },
})
