import fs from "node:fs/promises"
import path from "node:path"
import { ModelRequest, atomicJSON } from "./evidence"

type Stage = "before-bytes" | "during-tool-arguments" | "after-tool-result"
type Body = { model?: string; messages?: Array<{ role?: string }> }

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
  fault?: { stage: Stage; onTriggered: (stage: Stage) => void | Promise<void> }
}) {
  const endpoint = new URL(options.upstream.endsWith("/") ? options.upstream : options.upstream + "/")
  if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
    throw new Error("Live provider capture requires HTTPS")
  const token = crypto.randomUUID()
  const active = new Set<AbortController>()
  let triggered = false
  async function trigger(stage: Stage) {
    if (triggered || options.fault?.stage !== stage) return false
    triggered = true
    await options.fault.onTriggered(stage)
    return true
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
      active.add(controller)
      const abort = () => controller.abort(request.signal.reason)
      request.signal.addEventListener("abort", abort, { once: true })
      const handle = await fs.open(path.join(directory, "response.bin"), "wx", 0o600)
      let finishing: Promise<void> | undefined
      function finish(status: ModelRequest["status"]) {
        return (finishing ??= (async () => {
          record.status = status
          await handle.sync()
          await handle.close()
          await atomicJSON(path.join(directory, "request.json"), record)
          active.delete(controller)
          request.signal.removeEventListener("abort", abort)
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
        if ((await trigger("before-bytes")) || (afterTool && (await trigger("after-tool-result")))) {
          controller.abort()
          await upstream.body?.cancel().catch(() => {})
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
                  await finish(upstream.ok ? "completed" : "failed")
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
                    if (
                      line.includes('"tool_calls"') &&
                      line.includes('"arguments"') &&
                      (await trigger("during-tool-arguments"))
                    )
                      throw new Error("Acceptance tool-argument transport fault")
                  }
                }
                target.enqueue(chunk.value)
              } catch (error) {
                controller.abort(error)
                await reader.cancel(error).catch(() => {})
                await finish("failed")
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
    async [Symbol.asyncDispose]() {
      for (const controller of active) controller.abort()
      await server.stop(true)
    },
  }
}
