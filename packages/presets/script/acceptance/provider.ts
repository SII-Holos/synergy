import fs from "node:fs/promises"
import path from "node:path"
import { ModelRequest, atomicJSON } from "./evidence"

type Stage = "before-bytes" | "during-tool-arguments" | "after-tool-result"
type Body = { model?: string; messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] }
type Fault = {
  stage: Stage
  mode?: "disconnect" | "timeout"
  matches?: (body: Body) => boolean
  onTriggered: (stage: Stage) => void | Promise<void>
}

async function aborted(signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function usageOf(value: unknown): ModelRequest["usage"] {
  if (typeof value !== "object" || value === null || !("usage" in value)) return null
  const usage = value.usage
  if (typeof usage !== "object" || usage === null) return null
  const values = usage as Record<string, unknown>
  const count = (input: unknown) => (typeof input === "number" && input >= 0 ? input : null)
  return {
    input: count(values.prompt_tokens ?? values.input_tokens),
    output: count(values.completion_tokens ?? values.output_tokens),
  }
}

export async function readRequests(directory: string): Promise<ModelRequest[]> {
  const root = path.join(directory, "requests")
  if (
    !(await Bun.file(root).exists()) &&
    !(await fs.stat(root).then(
      (value) => value.isDirectory(),
      () => false,
    ))
  )
    return []
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  return Promise.all(
    entries.map(async (entry) => {
      try {
        return ModelRequest.parse(await Bun.file(path.join(root, entry.name, "request.json")).json())
      } catch {
        return { id: entry.name, status: "unknown" as const, usage: null }
      }
    }),
  )
}

export async function recordedProvider(options: {
  directory: string
  upstream: string
  apiKey: string
  provider: string
  fault?: Fault
}) {
  const endpoint = new URL(options.upstream.endsWith("/") ? options.upstream : options.upstream + "/")
  if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
    throw new Error("Live provider capture requires HTTPS")
  const token = crypto.randomUUID()
  const active = new Map<AbortController, Promise<void>>()
  let fault = options.fault
  async function trigger(stage: Stage, body: Body) {
    if (fault?.stage !== stage || (fault.matches && !fault.matches(body))) return
    const selected = fault
    fault = undefined
    await selected.onTriggered(stage)
    return selected.mode ?? "disconnect"
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Unauthorized", { status: 401 })
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
      const route = new URL(request.url).pathname.replace(/^\/v1\/?/, "").replace(/^\//, "")
      if (!["chat/completions", "responses"].includes(route))
        return new Response("Unsupported provider route", { status: 404 })
      const bytes = new Uint8Array(await request.arrayBuffer())
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Body
      const id = crypto.randomUUID()
      const directory = path.join(options.directory, "requests", id)
      const record: ModelRequest = { id, status: "unknown", usage: null, provider: options.provider, model: body.model }
      await atomicJSON(path.join(directory, "request.json"), record)
      await Bun.write(path.join(directory, "request.bin"), bytes, { mode: 0o600 })
      const controller = new AbortController()
      const settled = Promise.withResolvers<void>()
      active.set(controller, settled.promise)
      const abort = () => controller.abort(request.signal.reason)
      request.signal.addEventListener("abort", abort, { once: true })
      const handle = await fs.open(path.join(directory, "response.bin"), "wx", 0o600)
      const delivered = await fs.open(path.join(directory, "delivered.bin"), "wx", 0o600)
      let deliveredBytes = 0
      let injected: Fault["mode"]
      let finishing: Promise<void> | undefined
      function finish(status: ModelRequest["status"]) {
        return (finishing ??= (async () => {
          try {
            record.status = status
            await handle.sync()
            await delivered.sync()
            await atomicJSON(path.join(directory, "request.json"), record)
          } finally {
            await Promise.allSettled([handle.close(), delivered.close()])
            active.delete(controller)
            request.signal.removeEventListener("abort", abort)
            settled.resolve()
          }
        })())
      }
      try {
        const upstream = await fetch(new URL(route, endpoint), {
          method: "POST",
          body: bytes,
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        })
        await atomicJSON(path.join(directory, "response.json"), {
          status: upstream.status,
          contentType: upstream.headers.get("content-type"),
          requestID: upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id"),
        })
        const afterTool = body.messages?.some((message) => message.role === "tool") ?? false
        const earlyFault =
          (await trigger("before-bytes", body)) ?? (afterTool ? await trigger("after-tool-result", body) : undefined)
        if (earlyFault) {
          injected = earlyFault
          if (earlyFault === "timeout") {
            await aborted(controller.signal)
            await upstream.body?.cancel().catch(() => {})
            await finish("cancelled")
            return new Response(null, { status: 499 })
          }
          controller.abort()
          await upstream.body?.cancel().catch(() => {})
          await delivered.write("Acceptance transport fault")
          await finish("failed")
          return new Response("Acceptance transport fault", { status: 502 })
        }
        if (!upstream.body) {
          await finish(upstream.ok ? "completed" : "failed")
          return new Response(null, { status: upstream.status })
        }
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let pending = ""
        let pulling: Promise<void> | undefined
        const isSSE = upstream.headers.get("content-type")?.includes("text/event-stream") ?? false
        const output = new ReadableStream<Uint8Array>({
          pull(target) {
            pulling = (async () => {
              try {
                const chunk = await reader.read()
                if (chunk.done) {
                  if (!isSSE && pending) {
                    try {
                      record.usage = usageOf(JSON.parse(pending))
                    } catch {
                      /* A non-JSON failure body has unknown usage. */
                    }
                  }
                  await finish(controller.signal.aborted ? "cancelled" : upstream.ok ? "completed" : "failed")
                  target.close()
                  return
                }
                await handle.write(chunk.value)
                pending += decoder.decode(chunk.value, { stream: true })
                if (pending.length > 16 * 1024 * 1024) throw new Error("Provider frame exceeds recording bound")
                if (isSSE) {
                  let newline: number
                  while ((newline = pending.indexOf("\n")) >= 0) {
                    const line = pending.slice(0, newline).trim()
                    pending = pending.slice(newline + 1)
                    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue
                    let value: unknown
                    try {
                      value = JSON.parse(line.slice(5))
                    } catch {
                      continue
                    }
                    record.usage = usageOf(value) ?? record.usage
                    const argument = /"arguments"\s*:\s*"((?:\\.|[^"\\])+?)"/.exec(line)
                    const argumentFault =
                      line.includes('"tool_calls"') && argument
                        ? await trigger("during-tool-arguments", body)
                        : undefined
                    if (argument && argumentFault) {
                      injected = argumentFault
                      const captured = Buffer.from(await Bun.file(path.join(directory, "response.bin")).arrayBuffer())
                      const lineStart = captured.lastIndexOf(Buffer.from(line))
                      if (lineStart < 0) throw new Error("Recorded tool frame has no byte position")
                      const opening = argument.index + argument[0].length - argument[1]!.length - 1
                      const cut =
                        lineStart +
                        Buffer.byteLength(line.slice(0, opening)) +
                        Math.max(1, Math.floor(Buffer.byteLength(argument[1]!) / 2))
                      const prefix = captured.subarray(deliveredBytes, cut)
                      await delivered.write(prefix)
                      deliveredBytes += prefix.length
                      target.enqueue(prefix)
                      if (argumentFault === "timeout") {
                        await aborted(controller.signal)
                        await reader.cancel().catch(() => {})
                        await finish("cancelled")
                        target.close()
                        return
                      }
                      controller.abort()
                      await reader.cancel().catch(() => {})
                      await finish("failed")
                      target.close()
                      return
                    }
                  }
                }
                await delivered.write(chunk.value)
                deliveredBytes += chunk.value.length
                target.enqueue(chunk.value)
              } catch (error) {
                const cancelled = controller.signal.aborted && injected !== "disconnect"
                controller.abort(error)
                await reader.cancel(error).catch(() => {})
                await finish(cancelled ? "cancelled" : "failed")
                target.error(error)
              }
            })()
            return pulling
          },
          async cancel(reason) {
            controller.abort(reason)
            await reader.cancel(reason).catch(() => {})
            await pulling
            await finish("cancelled")
          },
        })
        return new Response(output, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" },
        })
      } catch (error) {
        await finish(controller.signal.aborted ? "cancelled" : "failed")
        throw error
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    token,
    arm(selected: Fault) {
      if (fault) throw new Error("An earlier provider fault has not triggered")
      fault = selected
    },
    async [Symbol.asyncDispose]() {
      const settling = [...active.values()]
      for (const controller of active.keys()) controller.abort()
      await server.stop(true)
      await Promise.all(settling)
    },
  }
}
