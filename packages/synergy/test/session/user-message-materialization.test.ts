import { describe, expect, test } from "bun:test"
import { SessionUserMessageMaterialization } from "@/session/user-message-materialization"
import type { MessageV2 } from "@/session/message-v2"

function message(input?: {
  text?: string
  origin?: MessageV2.User["origin"]
  partOrigin?: MessageV2.TextPart["origin"]
  extraParts?: MessageV2.Part[]
}): MessageV2.WithParts {
  const info: MessageV2.User = {
    id: "message_1",
    sessionID: "session_1",
    role: "user",
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
    time: { created: 123 },
    origin: input?.origin ?? { type: "user" },
  }
  return {
    info,
    parts: [
      {
        id: "part_1",
        messageID: info.id,
        sessionID: info.sessionID,
        type: "text",
        text: input?.text ?? "hello",
        origin: input?.partOrigin ?? "user",
      },
      ...(input?.extraParts ?? []),
    ],
  }
}

describe("SessionUserMessageMaterialization.input", () => {
  test("exposes only ordinary text and message metadata", () => {
    const input = SessionUserMessageMaterialization.input(message({ text: "hello\nworld" }))
    expect(input).toEqual({ message: { id: "message_1", text: "hello\nworld", createdAt: 123 } })
    expect(Object.keys(input!)).toEqual(["message"])
  })

  test("excludes system, cortex, and compaction messages", () => {
    expect(SessionUserMessageMaterialization.input(message({ partOrigin: "system" }))).toBeUndefined()
    expect(
      SessionUserMessageMaterialization.input(message({ origin: { type: "cortex", sessionID: "session_child" } })),
    ).toBeUndefined()
    expect(
      SessionUserMessageMaterialization.input(
        message({
          extraParts: [
            {
              id: "part_2",
              messageID: "message_1",
              sessionID: "session_1",
              type: "compaction",
              auto: false,
            },
          ],
        }),
      ),
    ).toBeUndefined()
  })

  test("includes channel and agenda materializations", () => {
    expect(SessionUserMessageMaterialization.input(message({ origin: { type: "channel" } }))?.message.text).toBe(
      "hello",
    )
    expect(
      SessionUserMessageMaterialization.input(message({ origin: { type: "agenda", sessionID: "session_source" } }))
        ?.message.text,
    ).toBe("hello")
  })
})
