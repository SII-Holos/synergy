import { AsyncLocalStorage } from "node:async_hooks"
import { RolloutTransportSchema } from "./transport-schema"
import { record, RolloutRecordingError } from "./error"

export namespace RolloutTransport {
  export type Event = RolloutTransportSchema.Event
  export type Sink = RolloutTransportSchema.Sink
  export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  export const sdkFetch: typeof globalThis.fetch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
      fetch(globalThis.fetch, input, init),
    { preconnect: globalThis.fetch.preconnect },
  )
  const context = new AsyncLocalStorage<Sink>()
  const responseHeaders = new Set(["x-request-id", "request-id", "x-amzn-requestid", "openai-processing-ms"])
  const requestOptions = new Set([
    "body",
    "cache",
    "credentials",
    "headers",
    "integrity",
    "keepalive",
    "method",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
    "signal",
    "duplex",
    "window",
  ])

  export function provide<T>(sink: Sink, action: () => T): T {
    return context.run(sink, action)
  }

  export async function fetch(fetchFn: Fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const sink = context.getStore()
    if (!sink) return fetchFn(input, init)
    const attemptID = crypto.randomUUID()
    const original = new Request(input, init)
    const endpoint = new URL(original.url)
    const controller = new AbortController()
    let finished = false
    let recordingFailure: unknown
    let responseOK = false
    async function emit(event: Event) {
      if (recordingFailure) throw recordingFailure
      try {
        await record(() => sink!(event))
      } catch (error) {
        recordingFailure = error
        controller.abort(error)
        throw error
      }
    }
    async function finish(status: "completed" | "failed" | "cancelled", error?: unknown) {
      if (finished || recordingFailure) return
      finished = true
      await emit({ type: "attempt-end", attemptID, status, error: error instanceof Error ? error.message : undefined })
    }
    function body(source: ReadableStream<Uint8Array>, channel: "request" | "response") {
      const reader = source.getReader()
      let ended = false
      let pending: Uint8Array | undefined
      let nextRead: ReturnType<typeof reader.read> | undefined
      let sourceEnded = false
      let sourceFailure: unknown
      async function readChunk() {
        if (sourceFailure) throw sourceFailure
        const buffer = new Uint8Array(RolloutTransportSchema.CHUNK_BYTES)
        let filled = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let deadline: Promise<undefined> | undefined
        try {
          while (filled < buffer.byteLength && !sourceEnded) {
            if (!pending) {
              nextRead ??= reader.read()
              const next = deadline ? await Promise.race([nextRead, deadline]) : await nextRead
              if (!next) break
              nextRead = undefined
              if (next.done) {
                sourceEnded = true
                break
              }
              pending = next.value
            }
            const length = Math.min(pending.byteLength, buffer.byteLength - filled)
            buffer.set(pending.subarray(0, length), filled)
            filled += length
            pending = pending.byteLength > length ? pending.subarray(length) : undefined
            if (filled && !deadline)
              deadline = new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), 25)
              })
          }
          return buffer.subarray(0, filled)
        } catch (error) {
          sourceFailure = error
          if (filled) return buffer.subarray(0, filled)
          throw error
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      async function close(complete: boolean, reason?: unknown) {
        if (ended) return
        ended = true
        pending = undefined
        let cleanupError: unknown
        try {
          if (!complete) await reader.cancel(reason)
        } catch (error) {
          cleanupError = error
        } finally {
          reader.releaseLock()
        }
        if (!recordingFailure) await emit({ type: "body-end", attemptID, channel, complete })
        if (cleanupError && !reason && !recordingFailure) throw cleanupError
      }
      return new ReadableStream<Uint8Array>(
        {
          async pull(output) {
            try {
              const chunk = await readChunk()
              if (!chunk.byteLength && sourceEnded) {
                await close(true)
                if (channel === "response") await finish(responseOK ? "completed" : "failed")
                output.close()
                return
              }
              if (chunk.byteLength) {
                await emit({ type: "chunk", attemptID, channel, data: chunk })
                output.enqueue(chunk)
              }
            } catch (error) {
              await close(false, error)
              if (!RolloutRecordingError.isInstance(error))
                await finish(original.signal.aborted ? "cancelled" : "failed", error)
              output.error(recordingFailure ?? error)
            }
          },
          async cancel(reason) {
            await close(false, reason)
            if (channel === "response") await finish("cancelled", reason)
          },
        },
        { highWaterMark: 0 },
      )
    }
    await emit({
      type: "attempt-start",
      attemptID,
      url: endpoint.origin + endpoint.pathname,
      method: original.method,
      mediaType: original.headers.get("content-type") ?? "application/octet-stream",
    })
    const requestBody = original.body ? body(original.body, "request") : undefined
    if (!requestBody) await emit({ type: "body-end", attemptID, channel: "request", complete: true })
    const request = new Request(original, {
      ...(requestBody ? { body: requestBody, duplex: "half" } : {}),
      signal: AbortSignal.any([original.signal, controller.signal]),
    })
    let response: Response | undefined
    try {
      const transportOptions = Object.fromEntries(
        Object.entries(init ?? {}).filter(([key]) => !requestOptions.has(key)),
      )
      response = await fetchFn(request, Object.keys(transportOptions).length ? transportOptions : undefined)
      responseOK = response.ok
      await emit({
        type: "response",
        attemptID,
        status: response.status,
        mediaType: response.headers.get("content-type") ?? "application/octet-stream",
        headers: Object.fromEntries([...response.headers].filter(([key]) => responseHeaders.has(key.toLowerCase()))),
      })
      if (!response.body) {
        await emit({ type: "body-end", attemptID, channel: "response", complete: true })
        await finish(responseOK ? "completed" : "failed")
        return response
      }
      return new Response(body(response.body, "response"), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      try {
        if (requestBody && !requestBody.locked) await requestBody.cancel(error)
        if (response?.body && !response.body.locked) await response.body.cancel(error)
      } catch (cleanupError) {
        if (!recordingFailure) throw cleanupError
      }
      await finish(original.signal.aborted ? "cancelled" : "failed", error)
      throw recordingFailure ?? error
    }
  }
}
