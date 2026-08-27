import { ResponseCard } from "@/channel/types"
import { Tool } from "../../tool/tool"

const MAX_RESPONSE_CARD_BYTES = 28 * 1024

const DESCRIPTION = `Prepare a provider-neutral response card for the current Channel conversation.

Use this only when structured presentation or bounded interaction is clearer than plain text. The card supports ordered text, button, and select elements. Buttons and selects return only their declared semantic values through the Channel callback path.

This tool creates response-card intent metadata. Channel delivery, provider rendering, callback verification, deduplication, and follow-up Session invocation are owned by the Channel runtime.

Do not use raw provider card JSON, URLs, free-form input controls, commands, or arbitrary tool calls; those capabilities are not part of the schema.`

export const ResponseCardTool = Tool.define("response_card", {
  description: DESCRIPTION,
  parameters: ResponseCard,
  async execute(card, ctx) {
    ctx.abort.throwIfAborted()
    const intent = { type: "response_card" as const, card }
    const estimatedBytes = new TextEncoder().encode(JSON.stringify(intent)).byteLength
    if (estimatedBytes > MAX_RESPONSE_CARD_BYTES) {
      throw new Error(
        `The response_card intent exceeds the provider-neutral 28 KiB limit (${estimatedBytes} bytes). Reduce the number or size of elements and retry once.`,
      )
    }

    const interactiveElementCount = card.elements.filter((element) => element.type !== "text").length
    return {
      title: `Response card: ${card.title}`,
      output: `Prepared a response card titled "${card.title}" with ${card.elements.length} element(s) for Channel delivery.`,
      metadata: {
        truncated: false,
        intent,
        elementCount: card.elements.length,
        interactiveElementCount,
        estimatedBytes,
      },
    }
  },
})
