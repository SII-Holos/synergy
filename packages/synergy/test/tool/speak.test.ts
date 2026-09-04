import { afterEach, describe, expect, mock, test } from "bun:test"
import { SpeakTool } from "../../src/tool/speak"
import { Voice } from "../../src/voice"

const ctx = {
  sessionID: "ses_speak_test",
  messageID: "msg_speak_test",
  callID: "call_speak_test",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

const originalSpeak = Voice.speak

afterEach(() => {
  ;(Voice.speak as typeof Voice.speak) = originalSpeak
})

describe("tool.speak", () => {
  test("rejects empty or whitespace-only text", async () => {
    const tool = await SpeakTool.init()
    await expect(tool.execute({ text: "   " }, ctx as never)).rejects.toThrow("non-empty text")
  })

  test("produces an audio attachment with media-generation display metadata", async () => {
    ;(Voice.speak as typeof Voice.speak) = mock(async () => ({
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/mpeg",
    }))

    const tool = await SpeakTool.init()
    const result = await tool.execute({ text: "Report ready", voice: "alloy" }, ctx as never)

    expect(result.output).toContain("4 B")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      type: "attachment",
      mime: "audio/mpeg",
      url: expect.stringMatching(/^asset:\/\//),
      presentation: { renderer: "audio", size: "medium" },
      model: { mode: "none" },
      metadata: {
        kind: "attachment",
        attachment: { originTool: "speak", deliverable: true },
      },
    })
    expect(result.metadata).toMatchObject({
      display: {
        kind: "media-generation",
        toolCard: "hidden",
        media: { type: "audio", pendingTitle: "Generating speech" },
      },
    })
    expect(Voice.speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Report ready", voice: "alloy", instructions: undefined }),
    )
  })

  test("forwards optional instructions and resolves configured defaults via Voice.speak", async () => {
    ;(Voice.speak as typeof Voice.speak) = mock(async () => ({
      data: new Uint8Array([9]),
      mimeType: "audio/mpeg",
    }))

    const tool = await SpeakTool.init()
    await tool.execute({ text: "Hello", instructions: "Speak slowly" }, ctx as never)

    expect(Voice.speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello", instructions: "Speak slowly", abortSignal: ctx.abort }),
    )
  })
})
