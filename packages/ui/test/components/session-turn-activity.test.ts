import { describe, expect, mock, test } from "bun:test"
import type {
  AssistantMessage,
  AttachmentPart,
  Part as PartType,
  PermissionRequest,
  ReasoningPart,
  ToolPart,
} from "@ericsanchezok/synergy-sdk/client"
import type { ActivityTimelineItem } from "../../src/components/session-turn-activity"
import type { SessionTurnTimelineItem } from "../../src/components/session-turn"
import { getSemanticIcon } from "../../src/components/semantic-icon"

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
  ActivityReasoningSummary: Empty,
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

const {
  activityItemStableKey,
  projectAssistantActivityItems,
  projectBalancedReasoningItems,
  projectMinimalActivityItems,
  resolveActivityDisplay,
} = await import("../../src/components/session-turn-activity")
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

function resolveToolInfo(tool: string, input: Record<string, unknown>, _metadata?: Record<string, unknown>) {
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
  resolveInfo?: (
    tool: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => ReturnType<typeof resolveToolInfo>
  isToolRenderBoundary?: (tool: string) => boolean
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
    resolveToolInfo: input.resolveInfo ?? resolveToolInfo,
    isToolRenderBoundary: input.isToolRenderBoundary,
  })
}

function activities(items: readonly ActivityTimelineItem[]) {
  return items.filter((item) => item.kind === "activity-group")
}

describe("balanced reasoning projection", () => {
  test("keeps a Thinking status row per assistant message while working", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const firstItems = project({
      message: first,
      parts: [reasoning("reason-a", first.id), text("answer-a", first.id)],
      working: true,
    })
    const secondItems = project({
      message: second,
      parts: [reasoning("reason-b", second.id)],
      working: true,
    })

    const projected = projectBalancedReasoningItems([...firstItems, ...secondItems], true)
    const summaries = projected.filter((item) => item.kind === "activity-reasoning-summary")

    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      key: "activity-reasoning:assistant-a:reason-a",
      partID: "reason-a",
      state: "pending",
      message: { id: "assistant-a" },
    })
    expect(summaries[1]).toMatchObject({
      key: "activity-reasoning:assistant-b:reason-b",
      partID: "reason-b",
      state: "pending",
      message: { id: "assistant-b" },
    })
    expect(projected.some((item) => item.kind === "passthrough" && item.item.part?.id === "answer-a")).toBe(true)
  })

  test("keeps a Reasoning fallback for a reasoning-only assistant beside an output-bearing one", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const projected = projectBalancedReasoningItems(
      [
        ...project({ message: first, parts: [text("answer-a", first.id)], working: false }),
        ...project({ message: second, parts: [reasoning("reason-b", second.id)], working: false }),
      ],
      false,
    )
    const summaries = projected.filter((item) => item.kind === "activity-reasoning-summary")

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      key: "activity-reasoning:assistant-b:reason-b",
      partID: "reason-b",
      state: "fallback",
      message: { id: "assistant-b" },
    })
    expect(projected.some((item) => item.kind === "activity-boundary")).toBe(false)
    expect(projected.some((item) => item.kind === "passthrough" && item.item.part?.id === "answer-a")).toBe(true)
  })

  test("keeps one Reasoning fallback per reasoning-only assistant message", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const projected = projectBalancedReasoningItems(
      [
        ...project({ message: first, parts: [reasoning("reason-a", first.id)], working: false }),
        ...project({ message: second, parts: [reasoning("reason-b", second.id)], working: false }),
      ],
      false,
    )
    const summaries = projected.filter((item) => item.kind === "activity-reasoning-summary")

    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      key: "activity-reasoning:assistant-a:reason-a",
      partID: "reason-a",
      state: "fallback",
      message: { id: "assistant-a" },
    })
    expect(summaries[1]).toMatchObject({
      key: "activity-reasoning:assistant-b:reason-b",
      partID: "reason-b",
      state: "fallback",
      message: { id: "assistant-b" },
    })
  })
  test("replaces each Thinking status row with its own live reasoning line while compact streaming", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const firstPart = reasoning("reason-a", first.id) as ReasoningPart
    const secondPart = reasoning("reason-b", second.id) as ReasoningPart
    const projected = projectBalancedReasoningItems(
      [
        ...project({ message: first, parts: [firstPart, text("answer-a", first.id)], working: true }),
        ...project({ message: second, parts: [secondPart], working: true }),
      ],
      true,
      {
        compactReasoningParts: new Map([
          [first.id, firstPart],
          [second.id, secondPart],
        ]),
      },
    )

    expect(projected.some((item) => item.kind === "activity-reasoning-summary")).toBe(false)
    const live = projected.filter((item) => item.kind === "passthrough" && item.item.kind === "reasoning")
    expect(live.map((item) => (item as { item: { part: { id: string } } }).item.part.id)).toEqual([
      "reason-a",
      "reason-b",
    ])
  })
  test("keeps one live line when one message emits reasoning around tool calls", () => {
    const message = assistant("assistant-a")
    const latestPart = reasoning("reason-b", message.id) as ReasoningPart
    const projected = projectBalancedReasoningItems(
      project({
        message,
        parts: [reasoning("reason-a", message.id), text("answer-a", message.id), latestPart],
        working: true,
      }),
      true,
      { compactReasoningParts: new Map([[message.id, latestPart]]) },
    )

    const live = projected.filter((item) => item.kind === "passthrough" && item.item.kind === "reasoning")
    expect(live).toHaveLength(1)
    expect((live[0] as { item: { part: { id: string } } }).item.part.id).toBe("reason-b")
  })

  test("keeps one Thinking row per message when reasoning repeats without compact", () => {
    const message = assistant("assistant-a")
    const projected = projectBalancedReasoningItems(
      project({
        message,
        parts: [reasoning("reason-a", message.id), text("answer-a", message.id), reasoning("reason-b", message.id)],
        working: true,
      }),
      true,
    )
    const summaries = projected.filter((item) => item.kind === "activity-reasoning-summary")

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      partID: "reason-a",
      state: "pending",
      message: { id: "assistant-a" },
    })
    expect(projected.some((item) => item.kind === "passthrough" && item.item.part?.id === "answer-a")).toBe(true)
  })

  test("anchors a completed assistant's compact row at its latest reasoning part while working", () => {
    const message = assistant("assistant-a")
    message.time.completed = 5000
    const latestPart = reasoning("reason-b", message.id) as ReasoningPart
    const projected = projectBalancedReasoningItems(
      project({
        message,
        parts: [reasoning("reason-a", message.id), text("answer-a", message.id), latestPart],
        working: true,
      }),
      true,
      { compactReasoningParts: new Map([[message.id, latestPart]]) },
    )
    const live = projected.filter((item) => item.kind === "passthrough" && item.item.kind === "reasoning")
    const answerIndex = projected.findIndex((item) => item.kind === "passthrough" && item.item.part?.id === "answer-a")
    const liveIndex = projected.findIndex((item) => item.kind === "passthrough" && item.item.kind === "reasoning")

    expect(live).toHaveLength(1)
    expect((live[0] as { item: { part: { id: string } } }).item.part.id).toBe("reason-b")
    expect(answerIndex).toBeGreaterThanOrEqual(0)
    expect(liveIndex).toBe(answerIndex + 1)
    expect(projected.filter((item) => item.kind === "activity-reasoning-summary")).toHaveLength(0)
  })
})

describe("activity display preference", () => {
  test("falls back missing and unknown values to balanced", () => {
    expect(resolveActivityDisplay(undefined)).toBe("balanced")
    expect(resolveActivityDisplay("unknown")).toBe("balanced")
    expect(resolveActivityDisplay("full")).toBe("full")
    expect(resolveActivityDisplay("balanced")).toBe("balanced")
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

  test("aggregates adjacent file changes across package subdirectories", () => {
    const groups = activities(
      project({
        parts: [
          tool({
            id: "save-source",
            tool: "save_file",
            args: { filePath: "/workspace/packages/ui/src/components/activity-trace.tsx" },
          }),
          tool({
            id: "revise-test",
            tool: "revise_file",
            args: { filePath: "/workspace/packages/ui/test/components/activity-trace.dom.test.ts" },
          }),
        ],
      }),
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ family: "modify-files", scopeKey: "path:/workspace/packages/ui" })
    expect(groups[0]?.steps.map((step) => step.part.id)).toEqual(["save-source", "revise-test"])
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

  test("preserves tools with dedicated renderers as passthrough boundaries", () => {
    const items = project({
      parts: [tool({ id: "read-a" }), tool({ id: "plugin", tool: "plugin_owned_tool" }), tool({ id: "read-b" })],
      isToolRenderBoundary: (name) => name === "plugin_owned_tool",
    })

    expect(activities(items).map((group) => group.steps.map((step) => step.part.id))).toEqual([["read-a"], ["read-b"]])
    expect(items.some((item) => item.kind === "passthrough" && item.item.part?.id === "plugin")).toBe(true)
  })

  test("computes boundaries before completed reasoning is hidden so group keys stay stable", () => {
    const parts = [tool({ id: "read-a" }), reasoning("thinking"), tool({ id: "read-b" }), text("answer")]
    const working = project({ parts, working: true })
    const completed = project({ parts, working: false })

    expect(activities(working).map(activityItemStableKey)).toEqual(activities(completed).map(activityItemStableKey))
    expect(activities(completed)).toHaveLength(2)
    expect(completed.some((item) => item.kind === "passthrough" && item.item.part?.id === "thinking")).toBe(false)
  })

  test("replaces completed reasoning-only content with a deterministic fallback summary", () => {
    const completed = project({ parts: [reasoning("thinking")], working: false })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      kind: "activity-reasoning-summary",
      key: "activity-reasoning:assistant-a:thinking",
      partID: "thinking",
      state: "fallback",
    })
    expect(JSON.stringify(completed)).not.toContain('"text":"Thinking"')
  })

  test("replaces streaming reasoning with a pending summary without retaining raw text", () => {
    const streaming = project({ parts: [reasoning("thinking")], working: true })

    expect(streaming).toHaveLength(1)
    expect(streaming[0]).toMatchObject({
      kind: "activity-reasoning-summary",
      key: "activity-reasoning:assistant-a:thinking",
      partID: "thinking",
      state: "pending",
    })
    expect(JSON.stringify(streaming)).not.toContain('"text":"Thinking"')
  })

  test("keeps persisted tool topics separate from the generic reasoning status", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 2,
        reasoning: {
          thinking: {
            state: "live",
            text: "Locating the activity rendering boundary",
            updatedAt: 10,
          },
        },
        groups: {
          "activity:assistant-a:inspect-local::read-a": {
            state: "stable",
            text: "Checked the relevant UI entry points",
            updatedAt: 11,
          },
        },
      },
    }
    const projected = project({
      message,
      parts: [reasoning("thinking"), tool({ id: "read-a" })],
      working: true,
    })

    const reasoningItems = projected.filter((item) => item.kind === "activity-reasoning-summary")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]?.text).toBeUndefined()
    expect(activities(projected)).toHaveLength(1)
    expect(activities(projected)[0]).toMatchObject({
      state: "done",
      topic: {
        state: "stable",
        text: "Checked the relevant UI entry points",
      },
    })
  })

  test("ignores legacy reasoning text when persisted semantic grouping has no topic", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 2,
        reasoning: {
          planning: {
            state: "live",
            text: "Researching the ZERO project",
            source: "nano",
            updatedAt: 10,
          },
        },
        groups: {
          "activity:assistant-a:inspect-local::read-zero": {
            state: "fallback",
            signature: "read-zero:web-zero",
            updatedAt: 11,
          },
        },
      },
    }
    const projected = project({
      message,
      parts: [
        reasoning("planning"),
        tool({ id: "read-zero", tool: "read" }),
        tool({ id: "web-zero", tool: "websearch" }),
      ],
      working: true,
    })
    const groups = activities(projected)

    const reasoningItems = projected.filter((item) => item.kind === "activity-reasoning-summary")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]?.text).toBeUndefined()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.steps.map((step) => step.family)).toEqual(["inspect-local", "research-web"])
    expect(groups[0]?.topic).toBeUndefined()
  })

  test("projects persisted nano topics across heterogeneous tool families", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        groups: {
          "activity:assistant-a:inspect-local:path:/workspace:read-flow": {
            state: "stable",
            signature: "read-flow:edit-flow:test-flow",
            text: "Implemented and verified the activity trace",
            updatedAt: 10,
          },
        },
      },
    }
    const groups = activities(
      project({
        message,
        parts: [
          tool({ id: "read-flow", tool: "read", args: { filePath: "/workspace/src/activity.ts" } }),
          tool({ id: "edit-flow", tool: "revise_file", args: { filePath: "/workspace/src/activity.ts" } }),
          tool({ id: "test-flow", tool: "bash", args: { command: "bun test" } }),
        ],
      }),
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.steps.map((step) => step.part.id)).toEqual(["read-flow", "edit-flow", "test-flow"])
    expect(groups[0]?.steps.map((step) => step.family)).toEqual(["inspect-local", "modify-files", "execute"])
    expect(groups[0]).toMatchObject({
      key: "activity:assistant-a:inspect-local:path:/workspace:read-flow",
      topic: { state: "stable", text: "Implemented and verified the activity trace" },
    })
  })

  test("does not use legacy reasoning text to merge an unsettled heterogeneous tail", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        reasoning: {
          planning: {
            state: "live",
            text: "Planning the ZERO refactor",
            source: "nano",
            updatedAt: 10,
          },
        },
        now: {
          text: "Planning the ZERO refactor",
          source: "reasoning",
          updatedAt: 10,
        },
      },
    }
    const projected = project({
      message,
      parts: [
        reasoning("planning"),
        tool({ id: "read-zero", tool: "read", args: { filePath: "/workspace/ZERO/README.md" }, status: "running" }),
        tool({ id: "web-zero", tool: "websearch", args: { query: "ZERO project" }, status: "running" }),
      ],
      working: true,
    })
    const groups = activities(projected)

    const reasoningItems = projected.filter((item) => item.kind === "activity-reasoning-summary")
    expect(reasoningItems).toHaveLength(1)
    expect(reasoningItems[0]?.text).toBeUndefined()
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.steps[0]?.family)).toEqual(["inspect-local", "research-web"])
    expect(groups.every((group) => group.topic?.text === undefined)).toBe(true)
  })

  test("ignores persisted semantic membership that crosses a presentation boundary", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        groups: {
          "activity:assistant-a:inspect-local::read-before": {
            state: "stable",
            signature: "read-before:plugin-card:read-after",
            text: "Invalid legacy group",
            updatedAt: 10,
          },
        },
      },
    }
    const groups = activities(
      project({
        message,
        parts: [
          tool({ id: "read-before" }),
          tool({ id: "plugin-card", tool: "plugin_owned_tool" }),
          tool({ id: "read-after" }),
        ],
        isToolRenderBoundary: (name) => name === "plugin_owned_tool",
      }),
    )

    expect(groups.map((group) => group.steps.map((step) => step.part.id))).toEqual([["read-before"], ["read-after"]])
    expect(groups.every((group) => group.topic === undefined)).toBe(true)
  })

  test("does not merge an unsettled streaming tail into a persisted semantic group", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        groups: {
          "activity:assistant-a:inspect-local:path:/workspace:read-flow": {
            state: "stable",
            signature: "read-flow:edit-flow:test-flow",
            text: "Implemented and verified the activity trace",
            updatedAt: 10,
          },
        },
      },
    }
    const groups = activities(
      project({
        message,
        parts: [
          tool({ id: "read-flow", tool: "read", args: { filePath: "/workspace/src/activity.ts" } }),
          tool({ id: "edit-flow", tool: "revise_file", args: { filePath: "/workspace/src/activity.ts" } }),
          tool({ id: "test-flow", tool: "bash", args: { command: "bun test" } }),
          tool({ id: "read-tail", tool: "read", args: { filePath: "/workspace/src/next.ts" } }),
        ],
      }),
    )

    expect(groups.map((group) => group.steps.map((step) => step.part.id))).toEqual([
      ["read-flow", "edit-flow", "test-flow"],
      ["read-tail"],
    ])
    expect(groups[1]?.topic).toBeUndefined()
  })

  test("caps a group at 24 steps and gives continuation groups their own first-part key", () => {
    const items = project({ parts: Array.from({ length: 25 }, (_, index) => tool({ id: `read-${index}` })) })
    const groups = activities(items)

    expect(groups.map((group) => group.steps.length)).toEqual([24, 1])
    expect(activityItemStableKey(groups[0]!)).toEndWith(":read-0")
    expect(activityItemStableKey(groups[1]!)).toEndWith(":read-24")
  })

  test("keeps DAG reads and mutations as expandable coordination receipts and never merges external actions", () => {
    const nodes = [{ id: "inspect", content: "Inspect activity projection", status: "completed", deps: [] }]
    const items = project({
      parts: [
        tool({ id: "read-a" }),
        tool({ id: "dag-read", tool: "dagread", metadata: { nodes, ready: [] } }),
        tool({ id: "read-b" }),
        tool({ id: "dag-write", tool: "dagwrite", metadata: { nodes, ready: [] } }),
        tool({ id: "email-a", tool: "email_send" }),
        tool({ id: "email-b", tool: "email_send" }),
      ],
    })
    const groups = activities(items)

    expect(groups.map((group) => group.steps.map((step) => step.part.id))).toEqual([
      ["read-a"],
      ["dag-read"],
      ["read-b"],
      ["dag-write"],
      ["email-a"],
      ["email-b"],
    ])
    expect(groups[1]).toMatchObject({ family: "coordination", receipt: true })
    expect(groups[1]?.steps[0]?.part.state.metadata).toEqual({ nodes, ready: [] })
    expect(groups[3]).toMatchObject({ family: "coordination", receipt: true })
    expect(groups[4]).toMatchObject({ family: "external-action", receipt: true })
    expect(groups[5]).toMatchObject({ family: "external-action", receipt: true })
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
    expect(waiting.steps.map((step) => step.state)).toEqual(["running", "waiting-approval"])
  })

  test("keeps successful, waiting, and failed DAG reads as coordination receipts", () => {
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

    expect(groups.map((group) => group.steps[0]?.part.id)).toEqual(["dag-success", "dag-waiting", "dag-error"])
    expect(groups.map((group) => ({ receipt: group.receipt, state: group.state }))).toEqual([
      { receipt: true, state: "done" },
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
    expect(failed.steps[1]?.part.state.status).toBe("error")
  })

  test("isolates tool info failures to the affected activity step", () => {
    const items = project({
      parts: [tool({ id: "broken", tool: "fixture_broken" }), tool({ id: "read-ok" })],
      resolveInfo: (name, input, metadata) => {
        if (name === "fixture_broken") throw new Error("Malformed plugin payload")
        return resolveToolInfo(name, input, metadata)
      },
    })

    expect(activities(items).flatMap((group) => group.steps.map((step) => step.part.id))).toEqual(["broken", "read-ok"])
    expect(activities(items)[0]?.steps[0]).toMatchObject({
      icon: getSemanticIcon("performance.tools"),
      title: "fixture_broken",
    })
  })

  test("keeps hidden tool failures available for explicit receipts", () => {
    const hiddenFailure = tool({ id: "hidden-error", tool: "openai_image_gen", status: "error" })
    hiddenFailure.state.metadata = { display: { toolCard: "hidden" } }

    const groups = activities(project({ parts: [hiddenFailure] }))

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ state: "error", receipt: true })
    expect(groups[0]?.steps[0]?.part.id).toBe("hidden-error")
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

  test("counts each nested topic step by its own family", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        groups: {
          "activity:assistant-a:inspect-local::read-zero": {
            state: "stable",
            signature: "read-zero:web-zero:test-zero",
            text: "Research the ZERO project",
            updatedAt: 10,
          },
        },
      },
    }
    const projected = project({
      message,
      parts: [
        tool({ id: "read-zero", tool: "read" }),
        tool({ id: "web-zero", tool: "websearch" }),
        tool({ id: "test-zero", tool: "bash", args: { command: "bun test" } }),
      ],
    })
    const minimal = projectMinimalActivityItems(projected, "root-user", true)
    const summary = minimal.find((item) => item.kind === "activity-summary")

    expect(summary?.kind === "activity-summary" ? summary.facts : []).toEqual([
      { family: "inspect-local", count: 1 },
      { family: "research-web", count: 1 },
      { family: "execute", count: 1 },
    ])
  })

  test("adds the latest bounded activity summary as the minimal now line", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        now: {
          text: "Verifying the compressed activity trace",
          source: "reasoning",
          updatedAt: 10,
        },
      },
    }
    const projected = project({ message, parts: [tool({ id: "read-a" })] })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)
    const summary = minimal.find((item) => item.kind === "activity-summary")

    expect(summary).toMatchObject({
      kind: "activity-summary",
      now: {
        text: "Verifying the compressed activity trace",
        source: "reasoning",
      },
    })
  })
  test("drops reasoning summary items while preserving the minimal now line", () => {
    const message = assistant()
    message.metadata = {
      activity: {
        v: 1,
        seq: 1,
        now: {
          text: "Verifying the compressed activity trace",
          source: "reasoning",
          updatedAt: 10,
        },
      },
    }
    const projected = project({ message, parts: [reasoning("thinking"), tool({ id: "read-a" })], working: true })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)

    expect(minimal.some((item) => item.kind === "activity-reasoning-summary")).toBe(false)
    expect(minimal.find((item) => item.kind === "activity-summary")).toMatchObject({
      now: { text: "Verifying the compressed activity trace", source: "reasoning" },
    })
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

  test("keeps stateful Inspire actions as explicit external-action receipts", () => {
    const projected = project({
      parts: [tool({ id: "read" }), tool({ id: "submit", tool: "inspire_submit" })],
    })
    const minimal = projectMinimalActivityItems(projected, "root-user", false)
    const receipts = minimal.filter((item) => item.kind === "activity-receipt")

    expect(receipts.map((item) => item.group.steps[0]?.part.id)).toEqual(["submit"])
    expect(receipts[0]?.group).toMatchObject({ family: "external-action", receipt: true })
  })

  test("preserves logical boundaries for later tool-only assistant messages", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const projected = [
      ...project({ message: first, parts: [tool({ id: "read-a", messageID: first.id })] }),
      ...project({ message: second, parts: [tool({ id: "read-b", messageID: second.id })] }),
    ]
    const minimal = projectMinimalActivityItems(projected, "root-user", false)

    expect(minimal.filter((item) => item.kind === "activity-summary")).toHaveLength(1)
    expect(minimal.find((item) => item.kind === "activity-boundary")).toMatchObject({
      message: { id: second.id },
    })
  })

  test("uses existing timeline keys for passthrough items", () => {
    const message = assistant()
    const item = collectSessionTurnTimelineItems([message], { [message.id]: [text("answer")] }, false)[0]!
    const projected: ActivityTimelineItem = { kind: "passthrough", item, message }

    expect(activityItemStableKey(projected)).toBe(timelineItemStableKey(item as SessionTurnTimelineItem))
  })
})

describe("terminal step projection freezing", () => {
  test("reuses the frozen step object for a completed part across re-projections", () => {
    const message = assistant()
    const part = tool({ id: "read-a" })
    const parts = [part]

    const first = project({ message, parts })
    const second = project({ message, parts })

    const firstStep = activities(first)[0]?.steps[0]
    const secondStep = activities(second)[0]?.steps[0]
    expect(firstStep).toBeDefined()
    expect(secondStep).toBe(firstStep)
  })

  test("does not freeze a running part", () => {
    const message = assistant()
    const part = tool({ id: "run-a", status: "running" })
    const parts = [part]

    const first = project({ message, parts })
    const second = project({ message, parts })

    const firstStep = activities(first)[0]?.steps[0]
    const secondStep = activities(second)[0]?.steps[0]
    expect(firstStep).toBeDefined()
    expect(secondStep).not.toBe(firstStep)
  })

  test("does not freeze a completed part while an approval is pending", () => {
    const message = assistant()
    const part = tool({ id: "approve-a" })
    const parts = [part]
    const permission = {
      tool: { messageID: message.id, callID: part.callID },
    } as PermissionRequest

    const first = project({ message, parts, permissions: [permission] })
    const second = project({ message, parts, permissions: [permission] })

    const firstStep = activities(first)[0]?.steps[0]
    const secondStep = activities(second)[0]?.steps[0]
    expect(firstStep).toBeDefined()
    expect(firstStep?.state).toBe("waiting-approval")
    expect(secondStep).not.toBe(firstStep)
  })

  test("recovers the terminal projection once a pending approval is removed", () => {
    const message = assistant()
    const part = tool({ id: "approve-b" })
    const parts = [part]
    const permission = {
      tool: { messageID: message.id, callID: part.callID },
    } as PermissionRequest

    const waiting = project({ message, parts, permissions: [permission] })
    expect(activities(waiting)[0]?.steps[0]?.state).toBe("waiting-approval")

    // The approval is replied and disappears from the permission list: the
    // projection must re-derive the terminal state instead of serving a
    // cached waiting-approval step.
    const settled = project({ message, parts, permissions: [] })
    expect(activities(settled)[0]?.steps[0]?.state).toBe("done")
  })
})
