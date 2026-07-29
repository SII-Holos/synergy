import { describe, expect, test } from "bun:test"
import { createOptimisticUserMessage } from "../../../src/components/prompt-input/optimistic-user-message"
import { DEFAULT_CAP, reconcileMessage } from "../../../src/context/session-message-window"
import { isOptimisticMessagePending } from "../../../src/context/session-optimistic-message"

describe("optimistic user message", () => {
  test("is immediately renderable as the canonical root while awaiting the server event", () => {
    const message = createOptimisticUserMessage({
      id: "msg_optimistic",
      sessionID: "ses_long",
      created: 123,
      agent: "synergy-max",
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "high",
      metadata: { promptDraft: { text: "Continue" } },
    })

    expect(message).toMatchObject({
      id: "msg_optimistic",
      sessionID: "ses_long",
      role: "user",
      isRoot: true,
      rootID: "msg_optimistic",
      visible: true,
      origin: { type: "user" },
      time: { created: 123 },
    })
    expect(message.isRoot === true && message.visible !== false).toBe(true)
    expect(isOptimisticMessagePending(message)).toBe(true)
  })

  test("stays in the rendered latest turns when a long-session window is full", () => {
    const existing = Array.from({ length: DEFAULT_CAP }, (_, index) =>
      createOptimisticUserMessage({
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID: "ses_long",
        created: index,
        agent: "synergy-max",
        model: { providerID: "openai", modelID: "gpt-5" },
      }),
    )
    const turnStart = existing.length - 20
    const optimistic = createOptimisticUserMessage({
      id: "msg_latest",
      sessionID: "ses_long",
      created: DEFAULT_CAP,
      agent: "synergy-max",
      model: { providerID: "openai", modelID: "gpt-5" },
    })

    const result = reconcileMessage(
      { messages: existing, mode: "latest", pendingLatest: false, pendingLatestIds: [] },
      optimistic,
    )
    const renderedRoots = result.window.messages
      .filter((message) => message.role === "user" && message.isRoot === true && message.visible !== false)
      .slice(turnStart)

    expect(result.window.messages).toHaveLength(DEFAULT_CAP)
    expect(result.droppedIds).toEqual(["msg_000"])
    expect(renderedRoots.at(-1)?.id).toBe("msg_latest")
  })
})
