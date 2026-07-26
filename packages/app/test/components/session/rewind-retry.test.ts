import { describe, expect, test } from "bun:test"
import type { Part, UserMessage } from "@ericsanchezok/synergy-sdk"
import { createRewindRetryInput } from "../../../src/components/session/rewind-retry"

describe("rewind retry", () => {
  test("replays the original user input with fresh message and part identities", () => {
    const message: UserMessage = {
      id: "msg_original",
      sessionID: "session-1",
      role: "user",
      time: { created: 123 },
      agent: "synergy-max",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      system: "system override",
      tools: { bash: false },
      summary: { title: "Original request", diffs: [] },
      metadata: {
        promptDraft: { version: 1, prompt: [], context: { items: [] } },
        command: { kind: "prompt" },
      },
    }
    const parts = [
      {
        id: "part_text",
        sessionID: "session-1",
        messageID: "msg_original",
        type: "text",
        text: "Retry this request",
        origin: "user",
        metadata: { source: "composer" },
      },
      {
        id: "part_system_text",
        sessionID: "session-1",
        messageID: "msg_original",
        type: "text",
        text: "Do not replay injected control text",
        origin: "system",
      },
      {
        id: "part_synthetic_text",
        sessionID: "session-1",
        messageID: "msg_original",
        type: "text",
        text: "Do not replay synthetic text",
        synthetic: true,
      },
      {
        id: "part_attachment",
        sessionID: "session-1",
        messageID: "msg_original",
        type: "attachment",
        mime: "text/plain",
        filename: "context.txt",
        url: "asset://context.txt",
        model: { mode: "content", text: "context" },
        metadata: { kind: "upload" },
      },
      {
        id: "part_retry",
        sessionID: "session-1",
        messageID: "msg_original",
        type: "retry",
        attempt: 1,
        error: { name: "APIError", data: { message: "failed", isRetryable: true } },
        time: { created: 456 },
      },
    ] as Part[]

    expect(createRewindRetryInput({ message, parts })).toEqual({
      sessionID: "session-1",
      agent: "synergy-max",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      system: "system override",
      tools: { bash: false },
      summary: { title: "Original request" },
      metadata: {
        promptDraft: { version: 1, prompt: [], context: { items: [] } },
        command: { kind: "prompt" },
      },
      parts: [
        {
          type: "text",
          text: "Retry this request",
          origin: "user",
          metadata: { source: "composer" },
        },
        {
          type: "attachment",
          mime: "text/plain",
          filename: "context.txt",
          url: "asset://context.txt",
          model: { mode: "content", text: "context" },
          metadata: { kind: "upload" },
        },
      ],
    })
  })

  test("does not retry non-user roots or messages without replayable input", () => {
    const message: UserMessage = {
      id: "msg_system",
      sessionID: "session-1",
      role: "user",
      time: { created: 123 },
      agent: "synergy",
      model: { providerID: "provider", modelID: "model" },
      origin: { type: "agenda" },
      isRoot: true,
    }
    const systemPart = {
      id: "part_system",
      sessionID: "session-1",
      messageID: "msg_system",
      type: "text",
      text: "Injected control text",
      origin: "system",
    } as Part
    const userPart = {
      ...systemPart,
      id: "part_user",
      text: "Replayable user text",
      origin: "user",
    } as Part

    expect(
      createRewindRetryInput({
        message: { ...message, origin: { type: "user" }, includeInContext: false },
        parts: [userPart],
      }),
    ).toBeUndefined()

    expect(createRewindRetryInput({ message, parts: [systemPart] })).toBeUndefined()
    expect(
      createRewindRetryInput({
        message: { ...message, origin: { type: "user" } },
        parts: [systemPart],
      }),
    ).toBeUndefined()
  })
})
