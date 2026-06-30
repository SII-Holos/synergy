import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part as PartType } from "@ericsanchezok/synergy-sdk/client"

const Empty = () => null

mock.module("../context", () => ({ useData: () => ({ store: {}, serverUrl: "" }) }))
mock.module("../context/diff", () => ({ useDiffComponent: () => Empty }))
mock.module("../hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    forceScrollToBottom: () => {},
    handleInteraction: () => {},
    handleScroll: () => {},
    scrollRef: undefined,
  }),
}))
mock.module("./accordion", () => {
  const Accordion = Object.assign(Empty, { Content: Empty, Item: Empty, Trigger: Empty })
  return { Accordion }
})
mock.module("./attachment-card", () => ({ AttachmentGallery: Empty }))
mock.module("./button", () => ({ Button: Empty }))
mock.module("./diff-changes", () => ({ DiffChanges: Empty }))
mock.module("./error-card", () => ({ ErrorCard: Empty }))
mock.module("./file-icon", () => ({ FileIcon: Empty }))
mock.module("./icon", () => ({ Icon: Empty }))
mock.module("./media-generation-card", () => ({ MediaGenerationCard: Empty }))
mock.module("./message-part", () => ({ Message: Empty, Part: Empty }))
mock.module("./session-turn.css", () => ({}))
mock.module("./special-user-message", () => ({
  getSpecialUserMessageRenderer: () => undefined,
  hasSpecialUserMessageRenderer: () => false,
}))
mock.module("./sticky-accordion-header", () => ({ StickyAccordionHeader: Empty }))
mock.module("./tool-renders", () => ({}))
mock.module("./typewriter", () => ({ Typewriter: Empty }))

const { collectSessionTurnTimelineItems, timelineItemStableKey } = await import("./session-turn")

function assistant(id: string): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    parentID: "user",
    mode: "test",
    agent: "synergy",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "model",
    providerID: "provider",
    time: { created: 1 },
  } as AssistantMessage
}

const image = {
  id: "file-image",
  sessionID: "session",
  messageID: "assistant-a",
  type: "attachment" as const,
  mime: "image/svg+xml",
  filename: "meme.svg",
  url: "asset://meme",
}

function mediaTool(input: {
  id: string
  messageID: string
  status: "pending" | "generating" | "running" | "completed"
  attachments?: (typeof image)[]
}): PartType {
  return {
    id: input.id,
    sessionID: "session",
    messageID: input.messageID,
    type: "tool",
    callID: `call-${input.id}`,
    tool: "plugin__synergy-meme-plugin__generate_meme",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: { prompt: "random meme" },
            output: "",
            title: "Meme",
            metadata: {
              display: {
                kind: "media-generation",
                toolCard: "hidden",
              },
            },
            attachments: input.attachments ?? [image],
            time: { start: 1, end: 2 },
          }
        : input.status === "running"
          ? {
              status: "running",
              input: { prompt: "random meme" },
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
              time: { start: 1 },
            }
          : {
              status: input.status,
              input: {},
              raw: '{"prompt":"random meme"',
              charsReceived: input.status === "generating" ? 23 : undefined,
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
            },
  } as PartType
}

function ordinaryTool(input: { id: string; messageID: string; status: "pending" | "generating" | "running" | "completed" }): PartType {
  return {
    id: input.id,
    sessionID: "session",
    messageID: input.messageID,
    type: "tool",
    callID: `call-${input.id}`,
    tool: "read",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: { filePath: "report.md" },
            output: "done",
            title: "report.md",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : input.status === "running"
          ? {
              status: "running",
              input: { filePath: "report.md" },
              metadata: {},
              time: { start: 1 },
            }
          : {
              status: input.status,
              input: {},
              raw: '{"filePath":"report.md"}',
              charsReceived: input.status === "generating" ? 24 : undefined,
              metadata: {},
            },
  } as PartType
}

describe("session turn timeline", () => {
  test("keeps reasoning before a running media placeholder and later text", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Thinking about a meme.",
      } as PartType,
      mediaTool({ id: "tool-a", messageID: message.id, status: "running" }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "来啦",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, true)

    expect(items.map((item) => item.kind)).toEqual(["reasoning", "media-pending", "part"])
    expect(items[0]).toMatchObject({ kind: "reasoning", part: { type: "reasoning" } })
    expect(items[2]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("shows a media placeholder from pending and generating tool input states", () => {
    const message = assistant("assistant-a")

    for (const status of ["pending", "generating"] as const) {
      const items = collectSessionTurnTimelineItems(
        [message],
        { [message.id]: [mediaTool({ id: `tool-${status}`, messageID: message.id, status })] },
        true,
      )

      expect(items.map((item) => item.kind)).toEqual(["media-pending"])
    }
  })

  test("hides completed-turn reasoning without moving later parts", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Hidden after completion.",
      } as PartType,
      mediaTool({ id: "tool-a", messageID: message.id, status: "completed" }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "done",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    expect(items.map((item) => item.kind)).toEqual(["tool-attachments", "part"])
    expect(items[0]).toMatchObject({ kind: "tool-attachments", files: [image] })
    expect(items[1]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("keeps completed media before later text and render tool across messages", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const third = assistant("assistant-c")
    const renderTool = {
      id: "render-c",
      sessionID: "session",
      messageID: third.id,
      type: "tool",
      callID: "call-render",
      tool: "render",
      state: {
        status: "completed",
        input: { html: "<div>Hello</div>" },
        output: "Rendered HTML",
        title: "HTML preview",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as PartType
    const partsByMessage: Record<string, PartType[]> = {
      [first.id]: [mediaTool({ id: "tool-a", messageID: first.id, status: "completed" })],
      [second.id]: [
        {
          id: "text-b",
          sessionID: "session",
          messageID: second.id,
          type: "text",
          text: "好了，我直接用 SVG 画一个给你",
        } as PartType,
      ],
      [third.id]: [renderTool],
    }

    const items = collectSessionTurnTimelineItems([first, second, third], partsByMessage, false)

    expect(items.map((item) => item.kind)).toEqual(["tool-attachments", "part", "part"])
    expect(items[0]).toMatchObject({ kind: "tool-attachments", files: [image] })
    expect(items[1]).toMatchObject({ kind: "part", part: { type: "text" } })
    expect(items[2]).toMatchObject({ kind: "part", part: { type: "tool", tool: "render" } })
  })

  test("keeps ordinary tool attachments inside the ordinary tool item", () => {
    const message = assistant("assistant-a")
    const readTool = {
      id: "read-a",
      sessionID: "session",
      messageID: message.id,
      type: "tool",
      callID: "call-read",
      tool: "read",
      state: {
        status: "completed",
        input: { file_path: "report.pdf" },
        output: "Read report.pdf",
        title: "report.pdf",
        metadata: {},
        attachments: [image],
        time: { start: 1, end: 2 },
      },
    } as PartType

    const items = collectSessionTurnTimelineItems([message], { [message.id]: [readTool] }, false)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "tool", tool: "read" } })
  })

  test("hides completed media tools without attachments when their tool card is hidden", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      mediaTool({ id: "tool-a", messageID: message.id, status: "completed", attachments: [] }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "继续",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    expect(items.map((item) => item.kind)).toEqual(["part"])
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("keeps ordinary tool timeline key stable across state updates", () => {
    const message = assistant("assistant-a")
    const keys = (["pending", "generating", "running", "completed"] as const).map((status) => {
      const items = collectSessionTurnTimelineItems(
        [message],
        { [message.id]: [ordinaryTool({ id: "tool-a", messageID: message.id, status })] },
        status !== "completed",
      )

      expect(items).toHaveLength(1)
      return timelineItemStableKey(items[0])
    })

    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe("tool:assistant-a:tool-a")
  })

  test("changes timeline key when a media tool changes render shape", () => {
    const message = assistant("assistant-a")
    const pending = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [mediaTool({ id: "tool-a", messageID: message.id, status: "pending" })] },
      true,
    )
    const completed = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [mediaTool({ id: "tool-a", messageID: message.id, status: "completed" })] },
      false,
    )

    expect(timelineItemStableKey(pending[0])).toBe("media-pending:assistant-a:tool-a")
    expect(timelineItemStableKey(completed[0])).toBe("tool-attachments:assistant-a:tool-a")
  })
})
