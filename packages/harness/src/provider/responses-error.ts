import { APICallError } from "ai"
import type { LanguageModelV4Middleware } from "@ai-sdk/provider"
import { providerRetryable } from "./retry"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

export function responsesError(value: unknown): APICallError | undefined {
  const event = record(value)
  if (event?.type !== "error" && event?.type !== "response.failed") return
  const source = event.type === "error" ? (record(event.error) ?? event) : record(record(event.response)?.error)
  const detail = {
    message: typeof source?.message === "string" ? source.message : "Provider response failed",
    code: typeof source?.code === "string" ? source.code : undefined,
    type: typeof source?.type === "string" ? source.type : undefined,
  }
  const responseHeaders = Object.fromEntries(
    Object.entries(record(source?.headers) ?? {})
      .filter(([key, value]) => /^(retry-after|retry-after-ms)$/i.test(key) && typeof value === "string")
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  )
  return new APICallError({
    message: detail.message,
    url: "",
    requestBodyValues: {},
    responseBody: JSON.stringify(detail),
    responseHeaders,
    isRetryable: providerRetryable(detail) ?? false,
  })
}

// The locked OpenAI adapter drops response.failed and error.headers during schema projection.
// Inspect its existing raw event once, before projection, without another SSE parser or retry owner.
export function responsesErrorMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
    async wrapStream({ doStream }) {
      const result = await doStream()
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type !== "raw") {
                controller.enqueue(part)
                return
              }
              const error = responsesError(part.rawValue)
              if (error) throw error
            },
          }),
        ),
      }
    },
  }
}
