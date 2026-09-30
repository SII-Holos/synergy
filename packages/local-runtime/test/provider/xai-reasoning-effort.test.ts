import { createXai } from "@ai-sdk/xai"
import { expect, test } from "bun:test"

const efforts = ["low", "medium", "high", "xhigh"] as const

test("grok chat accepts documented reasoning efforts past local schema validation", async () => {
  const xai = createXai({
    apiKey: "test-key",
    fetch: Object.assign(
      async () => {
        throw new Error("provider options accepted")
      },
      { preconnect() {} },
    ),
  })
  const model = xai.chat("grok-4.7")

  for (const reasoningEffort of efforts) {
    let error: unknown
    try {
      await Promise.resolve(
        model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
          providerOptions: { xai: { reasoningEffort } },
        }),
      )
    } catch (caught) {
      error = caught
    }
    const message = String(error)
    expect(message, reasoningEffort).toContain("provider options accepted")
    expect(message, reasoningEffort).not.toContain("invalid xai provider options")
  }
})
