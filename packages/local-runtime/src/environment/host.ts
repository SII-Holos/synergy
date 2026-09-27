import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"

type SocketData = { id: string; cursor: number; closed: boolean; drain?: () => void }
const Input = z.object({ data: z.string().max(90_000), end: z.boolean().default(false) })
const Cancel = z.object({ digest: z.string().length(64) })
const Size = z.object({ cols: z.number().int().min(1).max(65535), rows: z.number().int().min(1).max(65535) })

export namespace ExecutionHost {
  export function listen(input: {
    executor: Executor
    target: EnvironmentSchema.Target
    token: string
    listen: { unix: string } | { hostname: string; port: number }
    tls?: Bun.TLSOptions
    allowInsecure?: boolean
  }) {
    if (Buffer.byteLength(input.token) < 32) throw new Error("Execution Host tokens require at least 32 bytes")
    if (
      "hostname" in input.listen &&
      !["127.0.0.1", "::1", "localhost"].includes(input.listen.hostname) &&
      !input.tls &&
      !input.allowInsecure
    )
      throw new Error("Remote Execution Hosts require TLS")
    const token = Buffer.from(`Bearer ${input.token}`)
    const target = EnvironmentSchema.Target.parse(input.target)
    const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
    let closing = false
    const server = Bun.serve<SocketData>({
      ...input.listen,
      tls: input.tls,
      maxRequestBodySize: 8 * 1024 * 1024,
      async fetch(request, server) {
        if (closing) return new Response(null, { status: 503 })
        const supplied = Buffer.from(request.headers.get("authorization") ?? "")
        if (supplied.length !== token.length || !timingSafeEqual(supplied, token))
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        let suppliedTarget: EnvironmentSchema.Target
        try {
          suppliedTarget = EnvironmentSchema.Target.parse(JSON.parse(request.headers.get("x-synergy-target") ?? "null"))
        } catch {
          return Response.json({ error: "Invalid allocation" }, { status: 409 })
        }
        if (!EnvironmentSchema.sameTarget(suppliedTarget, target))
          return Response.json({ error: "Allocation changed" }, { status: 409 })
        try {
          const url = new URL(request.url)
          if (request.method === "GET" && url.pathname === "/v1/status")
            return Response.json({ version: ExecutionProtocol.version, target: input.target })
          if (request.method === "GET" && url.pathname === "/v1/openapi.json") return Response.json(openAPI())
          if (request.method === "POST" && url.pathname === "/v1/operations")
            return Response.json(await input.executor.start(ExecutionProtocol.Request.parse(await request.json())))
          const match = /^\/v1\/operations\/([^/]+)(?:\/(output|events|duplex|stdin|resize|cancel|release))?$/.exec(
            url.pathname,
          )
          if (!match) return Response.json({ error: "Not found" }, { status: 404 })
          const id = ExecutionProtocol.ID.parse(decodeURIComponent(match[1]))
          const action = match[2]
          if (action === "cancel" && request.method === "POST") {
            await input.executor.cancel(id, Cancel.parse(await request.json()).digest)
            return Response.json(true)
          }
          const status = await input.executor.status(id)
          if (!status) return Response.json({ error: "Execution not found" }, { status: 404 })
          if (!action && request.method === "GET") return Response.json(status)
          if (action === "output" && request.method === "GET")
            return Response.json(
              await input.executor.output(id, cursor(url), Number(url.searchParams.get("limit") ?? 128)),
            )
          if (action === "events" && request.method === "GET")
            return events(input.executor, id, cursor(url), request.signal)
          if (action === "duplex" && request.method === "GET") {
            if (server.upgrade(request, { data: { id, cursor: cursor(url), closed: false } })) return
            return Response.json({ error: "WebSocket upgrade required" }, { status: 400 })
          }
          if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
          if (action === "stdin") {
            const body = Input.parse(await request.json())
            await input.executor.stdin(id, Buffer.from(body.data, "base64"), body.end)
          } else if (action === "resize") {
            const body = Size.parse(await request.json())
            await input.executor.resize(id, body.cols, body.rows)
          } else if (action === "release") await input.executor.release(id)
          else return Response.json({ error: "Not found" }, { status: 404 })
          return Response.json(true)
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Executor request failed" },
            { status: error instanceof z.ZodError ? 400 : 409 },
          )
        }
      },
      websocket: {
        maxPayloadLength: 65_536,
        backpressureLimit: 1024 * 1024,
        open(socket) {
          if (closing) return
          sockets.add(socket)
          void (async () => {
            try {
              while (!socket.data.closed) {
                const chunks = await input.executor.output(socket.data.id, socket.data.cursor, 1)
                for (const chunk of chunks) {
                  const bytes = Buffer.from(chunk.data, "base64")
                  const frame = Buffer.allocUnsafe(9 + bytes.length)
                  frame[0] = chunk.stream === "stdout" ? 1 : 2
                  frame.writeDoubleBE(chunk.cursor, 1)
                  bytes.copy(frame, 9)
                  const sent = socket.send(frame)
                  if (sent === 0) return
                  socket.data.cursor = chunk.cursor
                  if (sent === -1)
                    await new Promise<void>((resolve) => {
                      socket.data.drain = resolve
                    })
                }
                const status = await input.executor.status(socket.data.id)
                if (!status) throw new Error("Execution not found")
                if (
                  socket.data.cursor >= status.cursor &&
                  (ExecutionProtocol.terminal(status) || status.state === "unknown")
                ) {
                  socket.send(JSON.stringify({ type: "status", status }))
                  return
                }
                if (!chunks.length) await Bun.sleep(50)
              }
            } catch {
              socket.send(
                JSON.stringify({ type: "error", message: "Execution stream unavailable; query operation status" }),
              )
            }
          })()
        },
        async message(socket, message) {
          try {
            if (typeof message !== "string") {
              await input.executor.stdin(socket.data.id, new Uint8Array(message))
              return
            }
            const control = z
              .discriminatedUnion("type", [
                Size.extend({ type: z.literal("resize") }),
                z.object({ type: z.literal("end") }),
              ])
              .parse(JSON.parse(message))
            if (control.type === "resize") await input.executor.resize(socket.data.id, control.cols, control.rows)
            else await input.executor.stdin(socket.data.id, new Uint8Array(), true)
          } catch {
            socket.send(JSON.stringify({ type: "error", message: "Invalid input or inactive execution" }))
          }
        },
        drain(socket) {
          socket.data.drain?.()
          socket.data.drain = undefined
        },
        close(socket) {
          sockets.delete(socket)
          socket.data.closed = true
          socket.data.drain?.()
        },
      },
    })
    const stop = async () => {
      closing = true
      for (const socket of sockets) {
        socket.data.closed = true
        socket.data.drain?.()
      }
      sockets.clear()
      // Provenance: https://github.com/oven-sh/bun/issues/36223
      // Bun 1.3.14 drains through stop(true); prior per-socket server closes poison its completion counter.
      await server.stop(true)
    }
    return { url: server.url, stop, [Symbol.asyncDispose]: stop }
  }

  function cursor(url: URL) {
    return z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(url.searchParams.get("after") ?? 0)
  }

  function events(executor: Executor, id: string, after: number, signal: AbortSignal) {
    let cursor = after
    let closed = false
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (!closed && !signal.aborted) {
              const [chunk] = await executor.output(id, cursor, 1)
              if (chunk) {
                controller.enqueue(
                  encoder.encode(`id: ${chunk.cursor}\nevent: output\ndata: ${JSON.stringify(chunk)}\n\n`),
                )
                cursor = chunk.cursor
                return
              }
              const status = await executor.status(id)
              if (!status) throw new Error("Execution not found")
              if (ExecutionProtocol.terminal(status) || status.state === "unknown") {
                controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`))
                controller.close()
                return
              }
              await Bun.sleep(100)
            }
            if (!closed) controller.close()
          } catch (error) {
            if (!closed) controller.error(error)
          }
        },
        cancel() {
          closed = true
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
    )
  }

  export function openAPI() {
    const json = (schema: z.ZodType) => ({
      content: { "application/json": { schema: z.toJSONSchema(schema, { target: "openapi-3.0" }) } },
    })
    const action = (summary: string, schema?: z.ZodType) => ({
      post: {
        summary,
        ...(schema ? { requestBody: { required: true, ...json(schema) } } : {}),
        responses: { "200": { description: "Accepted" } },
      },
    })
    const document = {
      openapi: "3.0.3",
      info: { title: "Synergy Execution Host", version: "1" },
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      paths: {
        "/v1/status": {
          get: {
            summary: "Inspect allocation and protocol version",
            responses: {
              "200": {
                description: "Allocation identity",
                ...json(z.object({ version: z.literal(1), target: EnvironmentSchema.Target })),
              },
            },
          },
        },
        "/v1/operations": {
          post: {
            summary: "Submit one deduplicated execution",
            requestBody: { required: true, ...json(ExecutionProtocol.Request) },
            responses: { "200": { description: "Execution status", ...json(ExecutionProtocol.Status) } },
          },
        },
        "/v1/operations/{id}": {
          get: {
            summary: "Inspect execution",
            responses: { "200": { description: "Execution status", ...json(ExecutionProtocol.Status) } },
          },
        },
        "/v1/operations/{id}/cancel": action("Request confirmed process-tree termination", Cancel),
        "/v1/operations/{id}/release": action("Acknowledge saved output and files"),
        "/v1/operations/{id}/stdin": action("Write binary input", Input),
        "/v1/operations/{id}/resize": action("Resize PTY", Size),
        "/v1/operations/{id}/output": {
          get: {
            summary: "Replay output after a cursor",
            responses: { "200": { description: "Output chunks", ...json(z.array(ExecutionProtocol.Chunk)) } },
          },
        },
        "/v1/operations/{id}/events": {
          get: {
            summary: "Stream resumable output and final status",
            responses: {
              "200": {
                description: "Server-sent events",
                content: { "text/event-stream": { schema: { type: "string" } } },
              },
            },
          },
        },
        "/v1/operations/{id}/duplex": {
          get: {
            summary: "Attach binary output and input with PTY controls",
            responses: { "101": { description: "WebSocket upgrade" } },
          },
        },
      },
    }
    const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "openapi-3.0" })
    return {
      ...document,
      paths: Object.fromEntries(
        Object.entries(document.paths).map(([route, item]) => [
          route,
          {
            ...item,
            parameters: [
              {
                name: "x-synergy-target",
                in: "header",
                required: true,
                content: { "application/json": { schema: schema(EnvironmentSchema.Target) } },
              },
              ...(route.includes("{id}")
                ? [{ name: "id", in: "path", required: true, schema: schema(ExecutionProtocol.ID) }]
                : []),
              ...(["/output", "/events", "/duplex"].some((suffix) => route.endsWith(suffix))
                ? [{ name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }]
                : []),
              ...(route.endsWith("/output")
                ? [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 128, default: 128 } }]
                : []),
            ],
          },
        ]),
      ),
    }
  }
}
