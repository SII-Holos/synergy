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

// The adapter can throw before exposing a stream or emit a raw failure during it.
// Both paths retain the same classification and retry hints without another SSE parser or retry owner.
export function responsesErrorMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
    async wrapStream({ doStream }) {
      let result: Awaited<ReturnType<typeof doStream>>
      try {
        result = await doStream()
      } catch (error) {
        if (APICallError.isInstance(error)) {
          const projected = responsesError(error.data)
          if (projected) {
            throw new APICallError({
              ...error,
              message: projected.message,
              isRetryable: projected.isRetryable,
              responseHeaders: { ...error.responseHeaders, ...projected.responseHeaders },
            })
          }
        }
        throw error
      }
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
