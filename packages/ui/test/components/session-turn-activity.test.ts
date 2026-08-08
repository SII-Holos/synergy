import { describe, expect, mock, test } from "bun:test"
import type {
  AssistantMessage,
  AttachmentPart,
  Part as PartType,
  PermissionRequest,
  ToolPart,
} from "@ericsanchezok/synergy-sdk/client"
import type { ActivityTimelineItem } from "../../src/components/session-turn-activity"
import type { SessionTurnTimelineItem } from "../../src/components/session-turn"

const Empty = () => null

mock.module("@ericsanchezok/synergy-util/model-limit", () => ({
  ModelLimit: {
    actualInput: (tokens: { input: number; cache: { read: number; write: number } }) =>
      tokens.input + tokens.cache.read + tokens.cache.write,
  },
}))
mock.module("@ericsanchezok/synergy-util/path", () => ({
  getDirectory: (path: string) => path.slice(0, path.lastIndexOf("/")),
  getFilename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
}))
mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id }),
}))
mock.module("solid-js", () => ({
  createEffect: () => {},
  createMemo: (fn: () => unknown) => fn,
  createSignal: (initial: unknown) => {
    let value = initial
    return [() => value, (next: unknown) => (value = typeof next === "function" ? next(value) : next)]
  },
  ErrorBoundary: Empty,
  For: Empty,
  Match: Empty,
  on: (_source: unknown, fn: unknown) => fn,
  onCleanup: () => {},
  Show: Empty,
  Switch: Empty,
}))
mock.module("solid-js/store", () => ({ createStore: (initial: unknown) => [initial, () => {}] }))
mock.module("solid-js/web", () => ({ Dynamic: Empty }))
mock.module("../../src/context", () => ({ useData: () => ({ store: {}, serverUrl: "" }) }))
mock.module("../../src/context/diff", () => ({ useDiffComponent: () => Empty }))
mock.module("../../src/hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    forceScrollToBottom: () => {},
    handleInteraction: () => {},
    handleScroll: () => {},
    scrollRef: undefined,
  }),
}))
mock.module("../../src/components/accordion", () => {
  const Accordion = Object.assign(Empty, { Content: Empty, Item: Empty, Trigger: Empty })
  return { Accordion }
})
mock.module("../../src/components/attachment-card", () => ({ AttachmentGallery: Empty }))
mock.module("../../src/components/button", () => ({ Button: Empty }))
mock.module("../../src/components/clipboard", () => ({
  createCopyController: () => ({
    copied: () => false,
    copy: () => {},
    disabled: () => false,
    icon: () => "copy",
    state: () => "idle",
    tooltip: () => "Copy Markdown",
  }),
}))
mock.module("../../src/components/activity-trace", () => ({
  ActivityReceipt: Empty,
  ActivityTrace: Empty,
  MinimalActivitySummary: Empty,
}))
mock.module("../../src/components/diff-changes", () => ({ DiffChanges: Empty }))
mock.module("../../src/components/compaction-card", () => ({ CompactionCard: Empty }))
mock.module("../../src/components/error-card", () => ({ ErrorCard: Empty }))
mock.module("../../src/components/file-icon", () => ({ FileIcon: Empty }))
mock.module("../../src/components/icon", () => ({ Icon: Empty }))
mock.module("../../src/components/media-generation-card", () => ({ MediaGenerationCard: Empty }))
mock.module("../../src/components/message-part", () => ({
  Message: Empty,
  Part: Empty,
  getToolInfo: (tool: string, input: Record<string, unknown>) => ({
    icon: "activity",
    title: tool,
    subtitle:
      (input.filePath as string | undefined) ??
      (input.url as string | undefined) ??
      (input.command as string | undefined),
  }),
}))
mock.module("../../src/components/session-turn.css", () => ({}))
mock.module("../../src/components/turn-change-summary-panel", () => ({ TurnChangeSummaryPanel: Empty }))
mock.module("../../src/components/special-user-message", () => ({ getSpecialUserMessageRenderer: () => undefined }))
mock.module("../../src/components/tool-renders", () => ({}))
mock.module("../../src/components/typewriter", () => ({ Typewriter: Empty }))

const { activityItemStableKey, projectAssistantActivityItems, projectMinimalActivityItems, resolveActivityDisplay } =
  await import("../../src/components/session-turn-activity")
const { collectSessionTurnTimelineItems, timelineItemStableKey } = await import("../../src/components/session-turn")

function assistant(id = "assistant-a"): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    parentID: "root-user",
    rootID: "root-user",
    mode: "test",
    agent: "synergy",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "model",
    providerID: "provider",
    time: { created: 1 },
  } as AssistantMessage
}

function tool(input: {
  id: string
  messageID?: string
  tool?: string
  args?: Record<string, unknown>
  status?: "running" | "completed" | "error"
  output?: string
  metadata?: Record<string, unknown>
}): ToolPart {
  const messageID = input.messageID ?? "assistant-a"
  const args = input.args ?? {}
  const status = input.status ?? "completed"
  return {
    id: input.id,
    sessionID: "session",
    messageID,
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "read",
    state:
      status === "completed"
        ? {
            status,
            input: args,
            output: input.output ?? "done",
            title: input.id,
            metadata: input.metadata ?? {},
            time: { start: 1, end: 2 },
          }
        : status === "error"
          ? {
              status,
              input: args,
              error: input.output ?? "Operation failed",
              metadata: input.metadata ?? {},
              time: { start: 1, end: 2 },
            }
          : {
              status,
              input: args,
              metadata: input.metadata ?? {},
              time: { start: 1 },
            },
  }
}

function text(id: string, messageID = "assistant-a"): PartType {
  return { id, sessionID: "session", messageID, type: "text", text: "Visible answer" } as PartType
}

function reasoning(id: string, messageID = "assistant-a"): PartType {
  return { id, sessionID: "session", messageID, type: "reasoning", text: "Thinking" } as PartType
}

function attachment(id: string, messageID = "assistant-a"): PartType {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "attachment",
    mime: "text/plain",
    filename: "report.txt",
    url: "asset://report",
  } as PartType
}

function resolveToolInfo(tool: string, input: Record<string, unknown>) {
  return {
    icon: "activity" as const,
    title: tool,
    subtitle:
      (input.filePath as string | undefined) ??
      (input.url as string | undefined) ??
      (input.command as string | undefined),
  }
}

function project(input: {
  parts: PartType[]
  working?: boolean
  permissions?: PermissionRequest[]
  message?: AssistantMessage
}) {
  const message = input.message ?? assistant()
  const partsByMessage = { [message.id]: input.parts }
  const source = collectSessionTurnTimelineItems([message], partsByMessage, true)
  const visible = collectSessionTurnTimelineItems([message], partsByMessage, input.working ?? true)
  return projectAssistantActivityItems({
    message,
    sourceItems: source,
    visibleItems: visible,
    permissions: input.permissions ?? [],
    resolveToolInfo,
  })
}

function activities(items: readonly ActivityTimelineItem[]) {
  return items.filter((item) => item.kind === "activity-group")
}

describe("activity display preference", () => {
  test("falls back missing and unknown values to balanced", () => {
    expect(resolveActivityDisplay(undefined)).toBe("balanced")
    expect(resolveActivityDisplay("unknown")).toBe("balanced")
    expect(resolveActivityDisplay("full")).toBe("full")
    expect(resolveActivityDisplay("minimal")).toBe("minimal")
  })
})

describe("session turn activity projection", () => {
  test("groups only adjacent tools with the same family and scope", () => {
    const items = project({
      parts: [
        tool({ id: "read-a", args: { filePath: "/workspace/src/a.ts" } }),
        tool({ id: "read-b", args: { filePath: "/workspace/src/b.ts" } }),
        tool({ id: "read-test", args: { filePath: "/workspace/test/a.test.ts" } }),
        tool({ id: "write-test", tool: "save_file", args: { filePath: "/workspace/test/a.test.ts" } }),
      ],
    })
    const groups = activities(items)

    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ family: "inspect-local", scopeKey: "path:/workspace/src" })
    expect(groups[0]?.steps.map((step) => step.part.id)).toEqual(["read-a", "read-b"])
    expect(groups[1]?.steps.map((step) => step.part.id)).toEqual(["read-test"])
    expect(groups[2]).toMatchObject({ family: "modify-files" })
  })

  test("keeps reasoning, text, attachments, render previews, and message identity as hard boundaries", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const firstItems = project({
      message: first,
      parts: [
        tool({ id: "read-a", messageID: first.id }),
        reasoning("reasoning", first.id),
        tool({ id: "read-b", messageID: first.id }),
        text("text", first.id),
        tool({ id: "read-c", messageID: first.id }),
        attachment("file", first.id),
        tool({ id: "read-d", messageID: first.id }),
        tool({ id: "render", messageID: first.id, tool: "render" }),
        tool({ id: "read-e", messageID: first.id }),
      ],
    })
    const secondItems = project({ message: second, parts: [tool({ id: "read-f", messageID: second.id })] })

    expect(activities(firstItems).map((group) => group.steps.map((step) => step.part.id))).toEqual([
      ["read-a"],
      ["read-b"],
      ["read-c"],
      ["read-d"],
      ["read-e"],
    ])
    expect(firstItems.some((item) => item.kind === "passthrough" && item.item.part?.id === "render")).toBe(true)
    expect(activityItemStableKey(activities(firstItems)[4]!)).not.toBe(
      activityItemStableKey(activities(secondItems)[0]!),
    )
  })

  test("computes boundaries before completed reasoning is hidden so group keys stay stable", () => {
    const parts = [tool({ id: "read-a" }), reasoning("thinking"), tool({ id: "read-b" }), text("answer")]
    const working = project({ parts, working: true })
    const completed = project({ parts, working: false })

    expect(activities(working).map(activityItemStableKey)).toEqual(activities(completed).map(activityItemStableKey))
    expect(activities(completed)).toHaveLength(2)
    expect(completed.some((item) => item.kind === "passthrough" && item.item.part?.id === "thinking")).toBe(false)
  })

  test("preserves reasoning-only content when completion promotes it to a visible part", () => {
    const completed = project({ parts: [reasoning("thinking")], working: false })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ kind: "passthrough", item: { kind: "part" } })
    expect(completed[0]?.kind === "passthrough" ? completed[0].item.part?.id : undefined).toBe("thinking")
  })

  test("caps a group at 24 steps and gives continuation groups their own first-part key", () => {
    const items = project({ parts: Array.from({ length: 25 }, (_, index) => tool({ id: `read-${index}` })) })
    const groups = activities(items)

    expect(groups.map((group) => group.steps.length)).toEqual([24, 1])
    expect(activityItemStableKey(groups[0]!)).toEndWith(":read-0")
    expect(activityItemStableKey(groups[1]!)).toEndWith(":read-24")
  })

  test("hides dagread, keeps DAG mutations as low-emphasis coordination receipts, and never merges external actions", () => {
    const items = project({
      parts: [
        tool({ id: "read-a" }),
        tool({ id: "dag-read", tool: "dagread" }),
        tool({ id: "read-b" }),
        tool({ id: "dag-write", tool: "dagwrite" }),
        tool({ id: "email-a", tool: "email_send" }),
        tool({ id: "email-b", tool: "email_send" }),
      ],
    })
    const groups = activities(items)

    expect(groups.map((group) => group.steps.map((step) => step.part.id))).toEqual([
      ["read-a"],
      ["read-b"],
      ["dag-write"],
      ["email-a"],
      ["email-b"],
    ])
    expect(groups[2]).toMatchObject({ family: "coordination", receipt: true })
    expect(groups[3]).toMatchObject({ family: "external-action", receipt: true })
    expect(groups[4]).toMatchObject({ family: "external-action", receipt: true })
  })

  test("keeps protected receipt families authoritative while allowing metadata to refine unknown tools", () => {
    const external = activities(
      project({
        parts: [
          tool({
            id: "email",
            tool: "email_send",
            metadata: { activityFamily: "inspect-local" },
          }),
        ],
      }),
    )[0]
    const refined = activities(
      project({
        parts: [
          tool({
            id: "custom",
            tool: "fixture_custom_tool",
            metadata: { activityFamily: "browser" },
          }),
        ],
      }),
    )[0]

    expect(external).toMatchObject({ family: "external-action", receipt: true })
    expect(refined).toMatchObject({ family: "browser", receipt: false })
  })

  test("does not expose raw input JSON for protected activity families", () => {
    const groups = activities(
      project({
        parts: [
          tool({
            id: "email",
            tool: "email_send",
            status: "running",
            args: { body: "private email body" },
          }),
          tool({
            id: "card",
            tool: "response_card",
            status: "running",
            args: { content: "private card content" },
          }),
          tool({
            id: "dag-write",
            tool: "dagwrite",
            status: "running",
            args: { nodes: [{ id: "private-node" }] },
          }),
        ],
      }),
    )

    expect(groups.map((group) => group.steps[0]?.preview)).toEqual([undefined, undefined, undefined])
  })

  test("scans the complete permission array by messageID and callID without changing group identity", () => {
    const parts = [tool({ id: "read-a", status: "running" }), tool({ id: "read-b", status: "running" })]
    const baseline = activities(project({ parts }))[0]!
    const permissions = [
      {
        id: "unrelated",
        sessionID: "session",
        permission: "read",
        patterns: [],
        metadata: {},
        tool: { messageID: "assistant-other", callID: "call-read-b" },
      },
      {
        id: "matching",
        sessionID: "session",
        permission: "read",
        patterns: [],
        metadata: {},
        tool: { messageID: "assistant-a", callID: "call-read-b" },
      },
    ] as PermissionRequest[]
    const waiting = activities(project({ parts, permissions }))[0]!

    expect(activityItemStableKey(waiting)).toBe(activityItemStableKey(baseline))
    expect(waiting.state).toBe("waiting-approval")
    expect(waiting.steps[1]?.permission?.id).toBe("matching")
  })

  test("shows hidden coordination tools when approval or failure requires a receipt", () => {
    const permissions = [
      {
        id: "permission",
        sessionID: "session",
        permission: "dagread",
        patterns: [],
        metadata: {},
        tool: { messageID: "assistant-a", callID: "call-dag-waiting" },
      },
    ] as PermissionRequest[]
    const groups = activities(
      project({
        permissions,
        parts: [
          tool({ id: "dag-success", tool: "dagread" }),
          tool({ id: "dag-waiting", tool: "dagread", status: "running" }),
          tool({ id: "dag-error", tool: "dagread", status: "error" }),
        ],
      }),
    )

    expect(groups.map((group) => group.steps[0]?.part.id)).toEqual(["dag-waiting", "dag-error"])
    expect(groups.map((group) => ({ receipt: group.receipt, state: group.state }))).toEqual([
      { receipt: true, state: "waiting-approval" },
      { receipt: true, state: "error" },
    ])
  })

  test("promotes errors without splitting the existing group or changing its key", () => {
    const runningParts = [tool({ id: "read-a", status: "running" }), tool({ id: "read-b", status: "running" })]
    const failedParts = [tool({ id: "read-a", status: "completed" }), tool({ id: "read-b", status: "error" })]
    const running = activities(project({ parts: runningParts }))[0]!
    const failed = activities(project({ parts: failedParts }))[0]!

    expect(activityItemStableKey(failed)).toBe(activityItemStableKey(running))
    expect(failed.state).toBe("error")
    expect(failed.steps[1]?.error).toBe("Operation failed")
    expect(failed.steps[1]?.preview).toBeUndefined()
  })

  test("filters hidden attachments from activity previews", () => {
    const completed = tool({ id: "attachments", output: "" })
    if (completed.state.status === "completed") {
      completed.state.attachments = [
        attachment("visible") as AttachmentPart,
        { ...attachment("hidden"), presentation: { hidden: true } } as AttachmentPart,
      ]
    }

    const preview = activities(project({ parts: [completed] }))[0]?.steps[0]?.preview

    expect(preview?.kind).toBe("attachments")
    expect(preview?.kind === "attachments" ? preview.files.map((file) => file.id) : []).toEqual(["visible"])
  })

  test("preserves media and promoted tool attachments on the existing timeline path", () => {
    const media = tool({ id: "media", tool: "plugin__synergy-meme-plugin__generate_meme", status: "running" })
    media.state.metadata = { display: { kind: "media-generation", toolCard: "hidden" } }
    const completed = tool({ id: "attachment-tool", tool: "attach" })
    if (completed.state.status === "completed") {
      completed.state.metadata = { display: { toolCard: "hidden" } }
      completed.state.attachments = [attachment("promoted") as never]
    }
    const items = project({ parts: [tool({ id: "read-a" }), media, completed, tool({ id: "read-b" })] })

    expect(activities(items).map((group) => group.steps.map((step) => step.part.id))).toEqual([["read-a"], ["read-b"]])
    expect(items.some((item) => item.kind === "passthrough" && item.item.kind === "media-pending")).toBe(true)
    expect(items.some((item) => item.kind === "passthrough" && item.item.kind === "tool-attachments")).toBe(true)
  })
})

describe("minimal activity projection", () => {
  test("emits one stable turn summary with fixed family fact order", () => {
    const message = assistant()
    const projected = project({
      message,
      parts: [
        tool({ id: "read-a" }),
        tool({ id: "write-a", tool: "save_file" }),
        tool({ id: "shell-a", tool: "bash", args: { command: "bun test" } }),
        tool({ id: "read-b" }),
      ],
    })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)
    const summary = minimal.find((item) => item.kind === "activity-summary")

    expect(minimal.filter((item) => item.kind === "activity-summary")).toHaveLength(1)
    expect(summary).toMatchObject({ total: 4, key: "activity-summary:root-user", completed: false })
    expect(summary?.kind === "activity-summary" ? summary.facts : []).toEqual([
      { family: "inspect-local", count: 2 },
      { family: "modify-files", count: 1 },
      { family: "execute", count: 1 },
    ])
  })

  test("renders no summary without ordinary activity", () => {
    const message = assistant()
    const full = collectSessionTurnTimelineItems([message], { [message.id]: [text("answer")] }, false)
    const passthrough: ActivityTimelineItem[] = full.map((item) => ({ kind: "passthrough", item, message }))

    expect(projectMinimalActivityItems(passthrough, "root-user", false)).toEqual(passthrough)
  })

  test("keeps permission, failure, and external-action receipts explicit at their original seams", () => {
    const permissions = [
      {
        id: "permission",
        sessionID: "session",
        permission: "read",
        patterns: [],
        metadata: {},
        tool: { messageID: "assistant-a", callID: "call-read-waiting" },
      },
    ] as PermissionRequest[]
    const projected = project({
      permissions,
      parts: [
        tool({ id: "read-ok" }),
        text("boundary"),
        tool({ id: "read-waiting", status: "running" }),
        tool({ id: "read-failed", status: "error" }),
        tool({ id: "email", tool: "email_send" }),
      ],
    })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)

    expect(minimal.filter((item) => item.kind === "activity-summary")).toHaveLength(1)
    expect(minimal.filter((item) => item.kind === "activity-receipt").map((item) => item.group.state)).toEqual([
      "waiting-approval",
      "error",
      "done",
    ])
    expect(minimal.findIndex((item) => item.kind === "passthrough" && item.item.part?.id === "boundary")).toBeLessThan(
      minimal.findIndex((item) => item.kind === "activity-receipt" && item.group.steps[0]?.part.id === "read-waiting"),
    )
  })

  test("keeps production communication as a detailed receipt instead of a family count", () => {
    const projected = project({
      parts: [tool({ id: "read" }), tool({ id: "card", tool: "response_card" })],
    })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)
    const summary = minimal.find((item) => item.kind === "activity-summary")
    const receipts = minimal.filter((item) => item.kind === "activity-receipt")

    expect(summary?.kind === "activity-summary" ? summary.total : 0).toBe(1)
    expect(summary?.kind === "activity-summary" ? summary.facts : []).toEqual([{ family: "inspect-local", count: 1 }])
    expect(receipts.map((item) => item.group.steps[0]?.part.id)).toEqual(["card"])
    expect(receipts[0]?.group).toMatchObject({ family: "produce", receipt: true })
  })

  test("uses existing timeline keys for passthrough items", () => {
    const message = assistant()
    const item = collectSessionTurnTimelineItems([message], { [message.id]: [text("answer")] }, false)[0]!
    const projected: ActivityTimelineItem = { kind: "passthrough", item, message }

    expect(activityItemStableKey(projected)).toBe(timelineItemStableKey(item as SessionTurnTimelineItem))
  })
})
