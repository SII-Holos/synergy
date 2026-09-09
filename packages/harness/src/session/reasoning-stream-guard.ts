import type { LanguageModelV2Middleware } from "@ai-sdk/provider"

/**
 * Keep malformed reasoning event sequences from terminating streamText.
 *
 * Some OpenAI-compatible endpoints and AI SDK's reasoning extractor can emit
 * an empty reasoning-end, or a delta, without a matching reasoning-start.
 * streamText treats that sequence as fatal. Repair only the missing boundary;
 * well-formed streams pass through unchanged.
 */
export function reasoningStreamGuardMiddleware(): LanguageModelV2Middleware {
  return {
    middlewareVersion: "v2",
    async wrapStream({ doStream }) {
      const result = await doStream()
      const activeReasoning = new Set<string>()

      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "reasoning-start") {
                activeReasoning.add(part.id)
                controller.enqueue(part)
                return
              }

              if (part.type === "reasoning-delta") {
                if (!activeReasoning.has(part.id)) {
                  controller.enqueue({
                    type: "reasoning-start",
                    id: part.id,
                    ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
                  })
                  activeReasoning.add(part.id)
                }
                controller.enqueue(part)
                return
              }

              if (part.type === "reasoning-end") {
                // An end without any content is produced for an empty
                // <think></think> block. There is no reasoning part to retain.
                if (!activeReasoning.delete(part.id)) return
                controller.enqueue(part)
                return
              }

              controller.enqueue(part)
            },
          }),
        ),
      }
    },
  }
}
