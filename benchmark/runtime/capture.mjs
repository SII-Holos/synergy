import { mkdir, open, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const identity = Symbol.for("synergy.benchmark.native-capture")

export function installCapture({ root, endpoint }) {
  const original = globalThis.fetch
  if (original[identity]?.root === root && original[identity]?.endpoint === endpoint) return () => {}
  async function json(file, value) {
    const temporary = file + "." + randomUUID()
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(value) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  }
  const recorded = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(endpoint + "/")) return original(input, init)
    const id = randomUUID()
    const directory = path.join(root, id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = {
      version: 1,
      id,
      protocol: url.endsWith("/responses") ? "responses" : "chat-completions",
      status: "dispatching",
      started_at: Date.now() / 1000,
      usage: null,
      ended_at: null,
    }
    const file = path.join(directory, "request.json")
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set("x-benchmark-client-request", id)
    const request = new Request(input instanceof Request ? input.clone() : input, init)
    const requestBody = await request.arrayBuffer()
    await writeFile(path.join(directory, "body.json"), Buffer.from(requestBody), { mode: 0o600 })
    await json(file, metadata)
    const cancellation = new AbortController()
    let response
    try {
      response = await original(input, {
        ...init,
        headers,
        signal: AbortSignal.any([request.signal, cancellation.signal]),
        ...(!["GET", "HEAD"].includes(request.method) ? { body: requestBody } : {}),
      })
    } catch (error) {
      metadata.status = error.name === "AbortError" ? "interrupted" : "failed"
      metadata.error = error.name
      metadata.ended_at = Date.now() / 1000
      await json(file, metadata)
      throw error
    }
    metadata.http_status = response.status
    if (!response.body) {
      metadata.status = response.ok ? "completed" : "http_error"
      metadata.ended_at = Date.now() / 1000
      await json(file, metadata)
      return response
    }
    const raw = await open(path.join(directory, "response.bin"), "w", 0o600)
    const reader = response.body.getReader()
    const streaming = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    const decoder = new TextDecoder()
    let pending = ""
    let usage = null
    let terminal = false
    let finishing
    let cancelled = false
    let writing = Promise.resolve()
    let parsing = true
    metadata.parse_errors = 0
    const readEvent = (data) => {
      if (data === "[DONE]") {
        terminal = true
        return
      }
      let event
      try {
        event = JSON.parse(data)
      } catch {
        metadata.parse_errors++
        return
      }
      const body = event.response ?? event
      if (body.usage != null) usage = body.usage
      if (["response.completed", "response.incomplete"].includes(event.type)) terminal = true
    }
    function parse(value, end = false) {
      if (!parsing) return
      pending += decoder.decode(value, { stream: !end })
      if (pending.length > 128 * 1024 * 1024) {
        metadata.parse_errors++
        parsing = false
        pending = ""
        return
      }
      if (!streaming) return
      pending = pending.replace(/\r\n/g, "\n")
      for (let index; (index = pending.indexOf("\n\n")) >= 0; ) {
        const frame = pending.slice(0, index)
        pending = pending.slice(index + 2)
        const lines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
        if (lines.length) readEvent(lines.join("\n"))
      }
    }
    function finish(status) {
      finishing ??= (async () => {
        metadata.status = status
        metadata.ended_at = Date.now() / 1000
        if (status === "completed" && metadata.parse_errors === 0) metadata.usage = usage
        else if (usage != null) metadata.observed_usage = usage
        try {
          await writing
          await raw.sync()
        } catch (error) {
          metadata.status = "recording_failed"
          metadata.error = error.code ?? error.name
          metadata.usage = null
        } finally {
          await raw.close()
        }
        await json(file, metadata)
      })()
      return finishing
    }
    const body = new ReadableStream(
      {
        async pull(controller) {
          try {
            const next = await reader.read()
            if (cancelled) return
            if (next.done) {
              parse(undefined, true)
              if (!streaming && response.ok) {
                readEvent(pending)
                terminal = true
              }
              await finish(response.ok ? (terminal ? "completed" : "failed") : "http_error")
              controller.close()
              return
            }
            writing = raw.writeFile(next.value)
            await writing
            if (cancelled) return
            parse(next.value)
            controller.enqueue(next.value)
          } catch (error) {
            cancellation.abort(error)
            void reader.cancel(error).catch(() => {})
            await finish("interrupted").catch(() => {})
            controller.error(error)
          }
        },
        async cancel(reason) {
          cancelled = true
          cancellation.abort(reason)
          void reader.cancel(reason).catch(() => {})
          await finish("interrupted")
        },
      },
      { highWaterMark: 0 },
    )
    const observed = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    Object.defineProperties(observed, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    })
    return observed
  }
  globalThis.fetch = Object.assign(recorded, { preconnect: original.preconnect, [identity]: { root, endpoint } })
  return () => {
    if (globalThis.fetch === recorded) globalThis.fetch = original
  }
}

if (process.env.BENCH_CAPTURE_DIR && process.env.BENCH_GATEWAY_BASE)
  installCapture({ root: process.env.BENCH_CAPTURE_DIR, endpoint: process.env.BENCH_GATEWAY_BASE })
