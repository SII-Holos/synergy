import { expect, spyOn, test } from "bun:test"
import type { ModelMessage } from "ai"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { contextMessages, contextText } from "../src/context"

test("quoted context masks text and tool data while preserving native media and source messages", async () => {
  const image = new URL("https://example.test/image.png")
  const data = new Uint8Array([1, 2, 3]).buffer
  const current: ModelMessage[] = [
    { role: "system", content: "original instruction with sensitive text" },
    {
      role: "user",
      content: [
        { type: "image", image },
        { type: "file", data, mediaType: "application/pdf", filename: "brief.pdf" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "reasoning", text: "", providerOptions: { openai: { reasoningEncryptedContent: "opaque" } } }],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "visible reasoning" },
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "inspect",
          input: {
            providerOptions: "business data",
            note: "sensitive",
            record: { type: "file", data: "sensitive business text" },
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "inspect",
          output: {
            type: "json",
            value: { type: "image", data: "sensitive business result", content: "sensitive", count: 2, empty: null },
          },
        },
      ],
    },
  ]
  const masking = spyOn(SecretMask, "apply").mockImplementation(async (value) =>
    value.replaceAll("sensitive", "[masked]"),
  )
  try {
    const messages = await contextMessages(current, { task: "assessment", reference: "sensitive" })
    expect(messages).toHaveLength(5)
    expect(messages[0]).toEqual({
      role: "user",
      content: "Recorded system context (quoted data):\noriginal instruction with [masked] text",
    })
    expect(messages[1]?.content).toEqual(current[1]?.content)
    expect(messages[2]?.content).toMatchObject([
      { type: "text", text: "Recorded assistant reasoning (quoted data):\nvisible reasoning" },
      {
        type: "tool-call",
        input: {
          providerOptions: "business data",
          note: "[masked]",
          record: { type: "file", data: "[masked] business text" },
        },
      },
    ])
    expect(messages[3]?.content).toMatchObject([
      {
        type: "tool-result",
        output: {
          value: { type: "image", data: "[masked] business result", content: "[masked]", count: 2, empty: null },
        },
      },
    ])
    expect(messages.at(-1)?.content).toContain('"reference":"[masked]"')
    expect(current[0]?.content).toContain("sensitive")
    const text = contextText(current)
    expect(text).toContain("visible reasoning")
    expect(text).toContain("business data")
    expect(text).toContain("sensitive business text")
    expect(text).toContain("sensitive business result")
    expect(text).toContain("brief.pdf")
    expect(text).not.toContain("opaque")
    expect(text).not.toContain("https://example.test")
  } finally {
    masking.mockRestore()
  }
})
