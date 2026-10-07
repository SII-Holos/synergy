import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const attachment: MessageV2.AttachmentPart = {
  id: "attachment",
  sessionID: "session",
  messageID: "message",
  type: "attachment",
  mime: "image/png",
  filename: "chart.png",
  url: "asset://0123456789abcdef.png",
}
const tool = {
  id: "tool",
  sessionID: "session",
  messageID: "message",
  type: "tool",
  tool: "view_image",
  callID: "call",
  state: { status: "completed", input: {}, title: "Image", output: "Loaded", metadata: {}, time: { start: 1, end: 2 } },
} satisfies MessageV2.ToolPart

describe("attachment purpose and bounded summaries", () => {
  test("uses the presentation contract independently of inference policy", () => {
    const evidence = {
      ...attachment,
      presentation: { purpose: "evidence" as const },
      model: { mode: "provider-file" as const },
    }
    expect(MessageV2.isDeliverableAttachment(evidence)).toBe(false)
    expect(MessageV2.isDeliverableAttachment({ ...evidence, presentation: { purpose: "deliverable" } })).toBe(true)
    expect(MessageV2.isDeliverableAttachment(attachment)).toBe(true)
    expect(MessageV2.AttachmentPart.parse(evidence).presentation?.purpose).toBe("evidence")
  })

  test("passes purpose counts and tool display through a bounded lazy summary", () => {
    const part: MessageV2.ToolPart = {
      ...tool,
      state: {
        ...tool.state,
        status: "completed",
        title: "Image",
        output: "private output".repeat(10000),
        time: { start: 1, end: 2 },
        attachments: [
          { ...attachment, url: "data:image/png;base64," + "A".repeat(500000), presentation: { purpose: "evidence" } },
          { ...attachment, id: "delivery", presentation: { purpose: "deliverable" } },
          { ...attachment, id: "hidden", presentation: { purpose: "evidence", hidden: true } },
        ],
      },
    }
    const summary = MessageV2.summarizePart(part)
    expect(summary.attachments).toEqual({ evidence: 1, deliverable: 1 })
    expect(summary.display).toBe("activity")
    expect(JSON.stringify(summary).length).toBeLessThan(700)
    expect(JSON.stringify(summary)).not.toContain("private output")
    expect(summary.content.bytes).toBeGreaterThan(500000)
  })

  test("carries generation boundaries and hidden attachment visibility into summary-only rendering", () => {
    const part: MessageV2.ToolPart = {
      ...tool,
      tool: "openai_image_gen",
      state: {
        ...tool.state,
        metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
      },
    }
    expect(MessageV2.summarizePart(part).display).toBe("content")
    expect(MessageV2.summarizePart({ ...attachment, presentation: { hidden: true } }).render).toBe(false)
    expect(MessageV2.summarizePart({ ...attachment, presentation: { purpose: "evidence" } }).attachments).toEqual({
      evidence: 1,
      deliverable: 0,
    })
  })
})
