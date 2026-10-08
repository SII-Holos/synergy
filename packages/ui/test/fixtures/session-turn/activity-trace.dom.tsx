import { batch, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "../../../src/testing/i18n.tsx"
import { CodeComponentProvider } from "../../../src/context/code.tsx"
import { DataProvider } from "../../../src/context/data.tsx"
import "../../../src/components/tool-renders.tsx"
import {
  ActivityReasoningSummary,
  ActivityReceipt,
  ActivityTrace,
  AnimatedActivityCount,
  MinimalActivitySummary,
} from "../../../src/components/activity-trace.tsx"

import { ActivityBatchLabel } from "../../../src/components/activity-batch.tsx"

const [countValue, setCountValue] = createSignal(9)
const [countIdentity, setCountIdentity] = createSignal("turn-a")
const [summaryCompleted, setSummaryCompleted] = createSignal(false)
const [railState, setRailState] = createSignal<"running" | "done">("running")

const resetCount = (identity: string, value: number) => {
  batch(() => {
    setCountIdentity(identity)
    setCountValue(value)
  })
}

const message = { id: "m1", sessionID: "s", role: "assistant", time: { created: 1 } }
const group = {
  kind: "activity-group",
  key: "group-a",
  message,
  family: "modify-files",
  scopeKey: "scope-a",
  state: "waiting-approval",
  steps: [
    {
      part: {
        id: "p1",
        sessionID: "s",
        messageID: "m1",
        callID: "approval-call",
        tool: "save_file",
        state: {
          status: "completed",
          input: { filePath: "/workspace/packages/ui/src/components/activity-trace.tsx" },
          output: "saved",
          metadata: {
            filediff: {
              file: "packages/ui/src/components/activity-trace.tsx",
              additions: 2,
              deletions: 1,
              preview: "old activity trace\nnew activity trace",
            },
          },
        },
      },
      family: "modify-files",
      scopeKey: "scope-a",
      icon: "file-pen",
      title: "Edit activity-trace",
      state: "waiting-approval",
    },
    {
      part: {
        id: "p2",
        tool: "webfetch",
        state: {
          status: "completed",
          input: { url: "https://example.com/activity-topic" },
          output: "found",
          metadata: {},
        },
      },
      family: "research-web",
      scopeKey: "activity-topic",
      icon: "globe",
      title: "Search activity topic grouping",
      state: "done",
    },
  ],
  receipt: false,
  topic: { state: "stable", text: "Updated the activity presentation" },
}
const [activityGroup, setActivityGroup] = createSignal(group)
const railGroup = (state: "running" | "done", key: string) => ({
  ...group,
  key,
  state,
  scopeKey: key,
  steps: [{ ...group.steps[1], part: { ...group.steps[1].part, id: key }, scopeKey: key, state }],
  topic: {
    state: state === "done" ? "stable" : "live",
    text: state === "done" ? "Finished rail work" : "Working through rail steps",
  },
})
const viewFileGroup = {
  ...group,
  key: "group-view-file",
  family: "inspect-local",
  scopeKey: "activity-trace.tsx",
  state: "done",
  steps: [
    {
      part: {
        id: "view-file",
        tool: "view_file",
        state: {
          status: "completed",
          input: { filePath: "/workspace/packages/ui/src/components/activity-trace.tsx" },
          output: "[activity-trace.tsx#TEST]\n1:const parity = true",
          metadata: {
            filepath: "/workspace/packages/ui/src/components/activity-trace.tsx",
            content: "const parity = true",
            tag: "TEST",
            totalLines: 1,
            offset: 0,
            limit: 1,
            ranges: [],
          },
        },
      },
      family: "inspect-local",
      scopeKey: "activity-trace.tsx",
      icon: "glasses",
      title: "View activity-trace.tsx",
      state: "done",
    },
  ],
  topic: { state: "stable", text: "Read the Activity Trace source" },
}
const errorGroup = {
  kind: "activity-group",
  key: "group-error",
  message,
  family: "execute",
  scopeKey: "build.sh",
  state: "error",
  steps: [
    {
      part: {
        id: "p-error",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "bash build.sh" },
          error: "bash: build.sh: command not found\nexit code 127",
          metadata: {
            approval: {
              status: "auto_allowed",
              mode: "autonomous",
              risk: "medium",
              audit: { visible: true },
            },
          },
          time: { start: 1, end: 2 },
        },
      },
      family: "execute",
      scopeKey: "build.sh",
      icon: "terminal",
      title: "Run build.sh",
      subtitle: "build.sh",
      state: "error",
    },
  ],
  receipt: false,
}
const delegateGroup = {
  kind: "activity-group",
  key: "group-delegate",
  message,
  family: "delegate",
  scopeKey: "task:child-1",
  state: "done",
  steps: [
    {
      part: {
        id: "p-task",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "explore", taskTitle: "Inspect the registry" },
          output: "done",
          metadata: {
            sessionId: "child-1",
            background: false,
            summary: [
              { id: "c1", tool: "bash", state: { status: "completed", title: "Ran tests" } },
              { id: "c2", tool: "read", state: { status: "running" } },
              { id: "c3", tool: "grep", state: { status: "generating" } },
            ],
          },
        },
      },
      family: "delegate",
      scopeKey: "task:child-1",
      icon: "list-todo",
      title: "Call subagent",
      subtitle: "Inspect the registry",
      state: "done",
    },
  ],
  receipt: false,
}
const delegateBackgroundGroup = {
  ...delegateGroup,
  key: "group-delegate-bg",
  scopeKey: "task:child-2",
  steps: [
    {
      ...delegateGroup.steps[0],
      part: {
        ...delegateGroup.steps[0].part,
        id: "p-task-bg",
        state: {
          ...delegateGroup.steps[0].part.state,
          status: "completed",
          metadata: { sessionId: "child-2", background: true, summary: [] },
        },
      },
      scopeKey: "task:child-2",
      state: "done",
    },
  ],
}
const taskReceipt = {
  kind: "activity-receipt",
  key: "receipt-task",
  message,
  group: {
    ...delegateGroup,
    key: "group-delegate-receipt",
    state: "error",
    receipt: true,
    steps: [
      {
        ...delegateGroup.steps[0],
        part: {
          ...delegateGroup.steps[0].part,
          id: "p-task-err",
          state: {
            status: "error",
            input: { subagent_type: "explore", taskTitle: "Inspect the registry" },
            error: "Agent type scout is not visible to synergy",
            metadata: { sessionId: "child-3", background: false, summary: [] },
          },
        },
        state: "error",
      },
    ],
  },
}
function CodeFixture(props: { file: { contents: string } }) {
  return <pre data-component="code-fixture">{props.file.contents}</pre>
}
const dagReceipt = {
  kind: "activity-receipt",
  key: "receipt-dag",
  message,
  group: {
    kind: "activity-group",
    key: "group-dag",
    message,
    family: "coordination",
    scopeKey: "",
    state: "done",
    steps: [
      {
        part: {
          id: "dag-read",
          tool: "dagread",
          state: {
            status: "completed",
            input: {},
            output: "",
            metadata: {
              nodes: [{ id: "inspect", content: "Inspect activity projection", status: "completed", deps: [] }],
              ready: [],
            },
          },
        },
        family: "coordination",
        scopeKey: "",
        icon: "list-checks",
        title: "Read DAG",
        subtitle: "DAG snapshot",
        state: "done",
      },
    ],
    receipt: true,
  },
}

const i18n = setupI18n()
const navigateCalls: string[] = []
const data = {
  session: [],
  session_diff: {},
  message: {},
  part: {},
}
// Session runtime state lives outside the Scope store; the view resolves
// it from this accessor bag.
const [hasApproval, setApproval] = createSignal(false)
const permissionCalls: unknown[] = []
let permissionReply: ReturnType<typeof Promise.withResolvers<void>> | undefined
const respondToPermission = (input: unknown) => {
  permissionCalls.push(input)
  permissionReply = Promise.withResolvers<void>()
  return permissionReply.promise
}
const NO_REQUESTS = []
const runtime = {
  statusFor: () => undefined,
  permissionsFor: () =>
    hasApproval()
      ? [
          {
            id: "approval-request",
            sessionID: "s",
            permission: "write",
            patterns: ["fixture"],
            metadata: {},
            tool: { messageID: "m1", callID: "approval-call" },
          },
        ]
      : NO_REQUESTS,
  questionsFor: () => NO_REQUESTS,
}
const root = document.querySelector("#root")!
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DataProvider
        data={data}
        runtime={runtime}
        directory="/workspace"
        serverUrl="http://localhost"
        onPermissionRespond={respondToPermission}
        onNavigateToSession={(id) => navigateCalls.push(id)}
      >
        <CodeComponentProvider component={CodeFixture}>
          <div id="count-host">
            <AnimatedActivityCount value={countValue()} identity={countIdentity()} />
          </div>
          <div id="batch-count-host">
            <ActivityBatchLabel
              identity={countIdentity()}
              live={true}
              total={countValue()}
              batch={{ facts: [{ family: "execute", count: countValue() }] }}
            />
          </div>
          <MinimalActivitySummary
            item={{
              kind: "activity-summary",
              key: "summary-a",
              message: { id: "m1", sessionID: "s", role: "assistant", time: { created: 1 } },
              total: 9,
              facts: [{ family: "modify-files", count: 3 }],
              completed: summaryCompleted(),
              now: { text: "Verifying compressed activity", source: "reasoning", updatedAt: 10 },
            }}
          />
          <div id="activity-main-host">
            <ActivityTrace group={activityGroup()} serverUrl="http://localhost" />
          </div>
          <div id="activity-rail-host">
            <div data-slot="session-turn-timeline-item" data-kind="activity-group" data-activity-continues="">
              <ActivityTrace group={railGroup(railState(), "rail-running")} serverUrl="http://localhost" />
            </div>
            <div data-slot="session-turn-timeline-item" data-kind="activity-group">
              <ActivityTrace group={railGroup("done", "rail-done")} serverUrl="http://localhost" />
            </div>
          </div>
          <div id="view-file-host">
            <ActivityTrace group={viewFileGroup} serverUrl="http://localhost" />
          </div>
          <div id="error-host">
            <ActivityTrace group={errorGroup} serverUrl="http://localhost" />
          </div>
          <div id="delegate-host">
            <ActivityTrace group={delegateGroup} serverUrl="http://localhost" />
          </div>
          <div id="delegate-bg-host">
            <ActivityTrace group={delegateBackgroundGroup} serverUrl="http://localhost" />
          </div>
          <div id="task-receipt-host">
            <ActivityReceipt item={taskReceipt} serverUrl="http://localhost" />
          </div>
          <div id="dag-receipt-host">
            <ActivityReceipt item={dagReceipt} serverUrl="http://localhost" />
          </div>
          <div id="reasoning-summary-host">
            <ActivityReasoningSummary
              item={{
                kind: "activity-reasoning-summary",
                key: "reasoning-pending",
                message: group.message,
                partID: "rp",
                state: "pending",
              }}
            />
            <ActivityReasoningSummary
              item={{
                kind: "activity-reasoning-summary",
                key: "reasoning-live",
                message: group.message,
                partID: "rl",
                state: "live",
                text: "Tracing the message flow",
                source: "nano",
              }}
            />
            <ActivityReasoningSummary
              item={{
                kind: "activity-reasoning-summary",
                key: "reasoning-stable",
                message: group.message,
                partID: "rs",
                state: "stable",
                text: "Mapped the message flow",
                source: "nano",
              }}
            />
            <ActivityReasoningSummary
              item={{
                kind: "activity-reasoning-summary",
                key: "reasoning-fallback",
                message: group.message,
                partID: "rf",
                state: "fallback",
              }}
            />
          </div>
        </CodeComponentProvider>
      </DataProvider>
    </I18nProvider>
  ),
  root,
)
;(globalThis as unknown as { __activityDomHarness: unknown }).__activityDomHarness = {
  setApproval,
  getPermissionCalls: () => permissionCalls,
  finishPermission: (failed: boolean) =>
    failed ? permissionReply?.reject(new Error("Approval unavailable")) : permissionReply?.resolve(),
  resetCount: (identity: string, value: number) => resetCount(identity, value),
  setCountValue: (value: number) => setCountValue(value),
  setSummaryCompleted: (completed: boolean) => setSummaryCompleted(completed),
  setRailState: (state: "running" | "done") => setRailState(state),
  getNavigateCalls: () => navigateCalls.slice(),

  refreshActivityGroup: () =>
    setActivityGroup((current) => ({
      ...current,
      steps: current.steps.map((step) => ({
        ...step,
        part: { ...step.part, state: { ...step.part.state } },
      })),
    })),
}
