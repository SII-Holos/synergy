import { describe, expect, test } from "bun:test"
import { ResponseCard } from "../../src/channel/types"
import { ResponseCardTool } from "../../src/channel/tools/response-card"
import type { Tool } from "../../src/tool/tool"

function context(): Tool.Context {
  return {
    sessionID: "ses_response_card",
    messageID: "msg_response_card",
    callID: "call_response_card",
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw new Error("response_card must not ask for permission")
    },
  }
}

const card = {
  title: "Choose a release path",
  elements: [
    { type: "text" as const, text: "Select how to continue.", format: "markdown" as const },
    {
      type: "button" as const,
      id: "approve_release",
      label: "Approve",
      value: "approve",
      style: "primary" as const,
    },
    {
      type: "select" as const,
      id: "release_channel",
      label: "Release channel",
      placeholder: "Choose a channel",
      options: [
        { label: "Canary", value: "canary" },
        { label: "Stable", value: "stable" },
      ],
    },
  ],
}

describe("response_card contract", () => {
  test("accepts only ordered text, button, and select elements", () => {
    expect(ResponseCard.parse(card)).toEqual(card)
  })

  test("rejects provider JSON, URLs, commands, tool calls, and free-form inputs", () => {
    for (const input of [
      { ...card, cardJson: {} },
      { ...card, elements: [{ type: "button", id: "open", label: "Open", value: "open", url: "https://x.test" }] },
      { ...card, elements: [{ type: "button", id: "run", label: "Run", value: "run", command: "rm -rf /" }] },
      {
        ...card,
        elements: [{ type: "button", id: "call", label: "Call", value: "call", toolCall: { tool: "bash" } }],
      },
      { ...card, elements: [{ type: "input", id: "notes", label: "Notes" }] },
    ]) {
      expect(ResponseCard.safeParse(input).success).toBe(false)
    }
  })

  test("requires unique interactive element IDs and option values", () => {
    expect(
      ResponseCard.safeParse({
        ...card,
        elements: [
          { type: "button", id: "decision", label: "Approve", value: "approve" },
          { type: "select", id: "decision", label: "Decision", options: [{ label: "Reject", value: "reject" }] },
        ],
      }).success,
    ).toBe(false)
    expect(
      ResponseCard.safeParse({
        ...card,
        elements: [
          {
            type: "select",
            id: "environment",
            label: "Environment",
            options: [
              { label: "Production", value: "production" },
              { label: "Prod", value: "production" },
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })

  test("returns provider-neutral intent metadata without external effects", async () => {
    const tool = await ResponseCardTool.init()
    const result = await tool.execute(card, context())

    expect(result.title).toBe("Response card: Choose a release path")
    expect(result.output).toContain("Prepared a response card")
    expect(result.output).not.toContain("Delivered")
    expect(result.metadata).toEqual({
      truncated: false,
      intent: {
        type: "response_card",
        card,
      },
      elementCount: 3,
      interactiveElementCount: 2,
      estimatedBytes: expect.any(Number),
    })
  })

  test("rejects intent payloads above the provider-neutral byte budget", async () => {
    const tool = await ResponseCardTool.init()
    await expect(
      tool.execute(
        {
          title: "Oversized card",
          elements: Array.from({ length: 8 }, (_, index) => ({
            type: "text" as const,
            text: `${index}:${"界".repeat(2_998)}`,
          })),
        },
        context(),
      ),
    ).rejects.toThrow("28 KiB")
  })
})
