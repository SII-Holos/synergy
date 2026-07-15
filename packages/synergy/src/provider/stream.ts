export namespace ProviderStream {
  export const SSE_EVENT_PARSER_BOUND_BYTES = 16 * 1024 * 1024

  export class SSEEventParserBoundError extends Error {
    constructor(parserBoundBytes: number) {
      super(`SSE event parser bound of ${parserBoundBytes} bytes exceeded`)
      this.name = "ProviderSSEEventParserBoundError"
    }
  }

  export function isSSE(headers: Headers): boolean {
    return headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
  }

  export function enforceSSEEventParserBound(
    stream: ReadableStream<Uint8Array>,
    parserBoundBytes = SSE_EVENT_PARSER_BOUND_BYTES,
  ): ReadableStream<Uint8Array> {
    let eventBytes = 0
    let atLineStart = true
    let previousWasCarriageReturn = false
    let previousCarriageReturnEndedEvent = false

    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const byte of chunk) {
            eventBytes++
            if (byte === 13) {
              previousCarriageReturnEndedEvent = atLineStart
              if (previousCarriageReturnEndedEvent) eventBytes = 0
              atLineStart = true
              previousWasCarriageReturn = true
            } else if (byte === 10) {
              if (previousWasCarriageReturn) {
                if (previousCarriageReturnEndedEvent) eventBytes = 0
                previousWasCarriageReturn = false
                previousCarriageReturnEndedEvent = false
              } else {
                if (atLineStart) eventBytes = 0
                atLineStart = true
              }
            } else {
              atLineStart = false
              previousWasCarriageReturn = false
              previousCarriageReturnEndedEvent = false
            }
            if (eventBytes > parserBoundBytes) throw new SSEEventParserBoundError(parserBoundBytes)
          }
          controller.enqueue(chunk)
        },
      }),
    )
  }
}
