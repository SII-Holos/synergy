import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const sessionID = "session"

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(id: string, parentID: string, error?: MessageV2.Assistant["error"]): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: "model",
    providerID: "provider",
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id,
    sessionID,
    messageID,
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("excludes messages marked includeInContext: false", () => {
    // Part-level model exclusion was removed (issue #281 §4.4); the only
    // model-context switch is the message-level includeInContext flag.
    const input: MessageV2.WithParts[] = [
      {
        info: { ...userInfo("m-user"), includeInContext: false },
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hidden from model",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([])
  })

  test("includes synthetic text parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/attachment parts and filters special parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p3"),
            type: "attachment",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
            model: { mode: "provider-file", summary: "img.png (image/png)" },
          },
          {
            ...basePart(messageID, "p4"),
            type: "attachment",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
            model: { mode: "provider-file", summary: "note.txt (text/plain)" },
          },
          {
            ...basePart(messageID, "p5"),
            type: "attachment",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
            model: { mode: "summary", summary: "dir (application/x-directory)" },
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          {
            type: "file",
            mediaType: "text/plain",
            filename: "note.txt",
            data: "https://example.com/note.txt",
          },
          {
            type: "text",
            text: "[Attachment: dir (application/x-directory)]",
          },
        ],
      },
    ])
  })
  test("uses explicit content instead of sending data text attachments", () => {
    const messageID = "m-user"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "this is the note content",
            synthetic: true,
          },
          {
            ...basePart(messageID, "p2"),
            type: "attachment",
            mime: "text/plain",
            filename: "note.xml",
            url: "data:text/plain;base64,PHhtbD5ub3RlIGNvbnRlbnQ8L3htbD4=",
            model: { mode: "none" },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "this is the note content" }],
      },
    ])
  })

  test("passes through provider-file text attachments with https URLs", () => {
    const messageID = "m-user"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "attachment",
            mime: "text/plain",
            filename: "doc.txt",
            url: "https://example.com/doc.txt",
            model: { mode: "provider-file", summary: "doc.txt (text/plain)" },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "text/plain",
            filename: "doc.txt",
            data: "https://example.com/doc.txt",
          },
        ],
      },
    ])
  })

  test("summarizes asset attachments instead of passing asset URLs to the provider", () => {
    const messageID = "m-user"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "attachment",
            mime: "text/plain",
            filename: "file.ts",
            url: "asset://abc123/file.ts",
            model: { mode: "provider-file", summary: "file.ts (text/plain)" },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[Attachment: file.ts (text/plain)]" }],
      },
    ])
  })

  test("uses attachment model policy for data text, https text, and images", () => {
    const messageID = "m-user"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "attachment",
            mime: "text/plain",
            filename: "note.xml",
            url: "data:text/plain;base64,PHhtbD5ub3RlIGNvbnRlbnQ8L3htbD4=",
            model: { mode: "none" },
          },
          {
            ...basePart(messageID, "p3"),
            type: "attachment",
            mime: "text/plain",
            filename: "doc.txt",
            url: "https://example.com/doc.txt",
            model: { mode: "provider-file", summary: "doc.txt (text/plain)" },
          },
          {
            ...basePart(messageID, "p4"),
            type: "attachment",
            mime: "image/png",
            filename: "photo.png",
            url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
            model: { mode: "provider-file", summary: "photo.png (image/png)" },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "text/plain",
            filename: "doc.txt",
            data: "https://example.com/doc.txt",
          },
          {
            type: "file",
            mediaType: "image/png",
            filename: "photo.png",
            data: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
          },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages and emits attachment message", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "attachment",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "https://example.com/attachment.png",
                  model: { mode: "summary", summary: "attachment.png (image/png)" },
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool bash returned attachment results:" },
          { type: "text", text: "[Attachment: attachment.png (image/png)]" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
          },
        ],
      },
    ])
  })

  test("removes OpenAI response item references from model provider metadata", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "continue",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "answer",
            metadata: {
              openai: {
                itemId: "rs_05cc53d0d93cbe50016a46668417b4819186ef05beefb099a1",
                reasoningEncryptedContent: "encrypted",
                retained: "ok",
              },
              custom: { keep: true },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "summary",
            time: { start: 0 },
            metadata: {
              openai: {
                itemId: "rs_reasoning",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "pwd" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: {
              openai: {
                itemId: "rs_tool",
                retained: "tool",
              },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "answer",
            providerOptions: {
              openai: { retained: "ok" },
              custom: { keep: true },
            },
          },
          {
            type: "reasoning",
            text: "summary",
            providerOptions: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "pwd" },
            providerExecuted: undefined,
            providerOptions: {
              openai: { retained: "tool" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessage(input)).toStrictEqual([])
  })
})
