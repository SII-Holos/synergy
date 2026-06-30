import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part as PartType } from "@ericsanchezok/synergy-sdk/client"
import { collectSessionTurnNarrativeItems } from "./session-turn-narrative"

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

describe("session turn narrative", () => {
  test("keeps reasoning before a running media placeholder", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Thinking about a meme.",
      } as PartType,
      {
        id: "tool-a",
        sessionID: "session",
        messageID: message.id,
        type: "tool",
        callID: "call-a",
        tool: "plugin__synergy-meme-plugin__generate_meme",
        state: {
          status: "running",
          input: { prompt: "random meme" },
          metadata: { display: { kind: "media-generation", visibility: "media" } },
          time: { start: 1 },
        },
      } as PartType,
    ]

    const items = collectSessionTurnNarrativeItems([message], { [message.id]: parts }, true)

    expect(items.map((item) => item.kind)).toEqual(["part", "media-pending"])
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "reasoning" } })
  })

  test("keeps completed media before later assistant text", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const partsByMessage: Record<string, PartType[]> = {
      [first.id]: [
        {
          id: "tool-a",
          sessionID: "session",
          messageID: first.id,
          type: "tool",
          callID: "call-a",
          tool: "plugin__synergy-meme-plugin__generate_meme",
          state: {
            status: "completed",
            input: { prompt: "random meme" },
            output: "",
            title: "Kombucha Girl",
            metadata: {
              display: {
                kind: "media-generation",
                visibility: "media",
                presentation: "attachment-only",
                primaryAttachmentIds: [image.id],
              },
            },
            attachments: [image],
            time: { start: 1, end: 2 },
          },
        } as PartType,
      ],
      [second.id]: [
        {
          id: "text-b",
          sessionID: "session",
          messageID: second.id,
          type: "text",
          text: "来啦，随便发一张",
        } as PartType,
      ],
    }

    const items = collectSessionTurnNarrativeItems([first, second], partsByMessage, false)

    expect(items.map((item) => item.kind)).toEqual(["media-result", "part"])
    expect(items[0]).toMatchObject({ kind: "media-result", files: [image] })
    expect(items[1]).toMatchObject({ kind: "part", part: { type: "text" } })
  })
})
