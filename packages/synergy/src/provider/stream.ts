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

  export function withIdleTimeout(
    stream: ReadableStream<Uint8Array>,
    input: {
      controller: AbortController
      signal: AbortSignal
      timeoutMs: number
    },
  ): ReadableStream<Uint8Array> {
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let readerReleased = false
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
    }
    const releaseReader = () => {
      if (!reader || readerReleased) return
      readerReleased = true
      try {
        reader.releaseLock()
      } catch {}
    }
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        input.controller.abort(
          new DOMException(`Idle timeout: no data received within ${input.timeoutMs}ms`, "TimeoutError"),
        )
      }, input.timeoutMs).unref()
    }
    const readWithAbort = async (ownedReader: ReadableStreamDefaultReader<Uint8Array>) => {
      input.signal.throwIfAborted()
      let onAbort!: () => void
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(input.signal.reason ?? new DOMException("Aborted", "AbortError"))
        input.signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        return await Promise.race([ownedReader.read(), aborted])
      } finally {
        input.signal.removeEventListener("abort", onAbort)
      }
    }

    // Keep provider reads pull-based so downstream demand bounds queued bytes,
    // and release the owned reader on every terminal path.
    return new ReadableStream({
      async pull(controller) {
        reader ??= stream.getReader()
        try {
          const { done, value } = await readWithAbort(reader)
          if (done) {
            cleanup()
            releaseReader()
            controller.close()
            return
          }
          resetIdle()
          controller.enqueue(value)
        } catch (error) {
          cleanup()
          try {
            await reader.cancel(error)
          } catch {
          } finally {
            releaseReader()
          }
          controller.error(error)
        }
      },
      async cancel(reason) {
        cleanup()
        if (!reader) return stream.cancel(reason)
        try {
          await reader.cancel(reason)
        } finally {
          releaseReader()
        }
      },
    })
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
