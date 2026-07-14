export namespace ProviderStream {
  export const SSE_EVENT_MAX_BYTES = 16 * 1024 * 1024

  export class SSEEventTooLargeError extends Error {
    constructor(maxBytes: number) {
      super(`SSE event exceeded ${maxBytes} bytes`)
      this.name = "ProviderSSEEventTooLargeError"
    }
  }

  export function isSSE(headers: Headers): boolean {
    return headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
  }

  export function limitSSEEventBytes(
    stream: ReadableStream<Uint8Array>,
    maxBytes = SSE_EVENT_MAX_BYTES,
  ): ReadableStream<Uint8Array> {
    let eventBytes = 0
    let atLineStart = true
    let previousWasCarriageReturn = false

    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const byte of chunk) {
            eventBytes++
            if (byte === 13) {
              if (atLineStart) eventBytes = 0
              atLineStart = true
              previousWasCarriageReturn = true
            } else if (byte === 10) {
              if (previousWasCarriageReturn) {
                previousWasCarriageReturn = false
              } else {
                if (atLineStart) eventBytes = 0
                atLineStart = true
              }
            } else {
              atLineStart = false
              previousWasCarriageReturn = false
            }
            if (eventBytes > maxBytes) throw new SSEEventTooLargeError(maxBytes)
          }
          controller.enqueue(chunk)
        },
      }),
    )
  }
}
