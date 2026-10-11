import { Hono, type Context } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import type { WSContext, WSMessageReceive } from "hono/ws"
import { describeRoute, resolver } from "hono-openapi"
import { HostConnection } from "@ericsanchezok/synergy-harness/host/connection"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"

const gateway = "/host-connection/gateway"
const maxBody = 72 * 1024 * 1024
const json = async (c: Context) =>
  JSON.parse(new TextDecoder().decode(await HostConnection.readBody(c.req.raw, 32768))) as unknown

async function pairingResponse(c: Context, execute: () => Promise<unknown>) {
  try {
    return c.json(await execute())
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ name: "HostConnectionRejected", data: { message: "Invalid pairing request" } }, 400)
    throw error
  }
}

function apiPath(path: string) {
  const normalized = new URL(decodeURIComponent(path.split("?")[0]).replaceAll("\\", "/"), "http://host.invalid")
  if (
    !path.startsWith("/") ||
    normalized.origin !== "http://host.invalid" ||
    normalized.pathname.split("/")[1] === "host-connection"
  )
    throw new Error("Remote connection management cannot be forwarded")
  return path
}

export function HostConnectionRoute(input: {
  forward: (request: Request, env: unknown) => Promise<Response>
  originAllowed: (origin: string | undefined, url: string) => boolean
}) {
  return new Hono()
    .get(
      "/peers",
      describeRoute({
        summary: "List paired remote Hosts",
        operationId: "hostConnection.peers",
        responses: {
          200: {
            description: "Paired devices",
            content: { "application/json": { schema: resolver(z.array(HostConnection.Peer)) } },
          },
        },
      }),
      async (c) => c.json(await HostConnection.peers()),
    )
    .get("/gateway/descriptor", async (c) => c.json(await HostConnection.describe()))
    .post("/gateway/pair", (c) =>
      pairingResponse(c, async () => HostConnection.receivePair(HostConnection.PairRequest.parse(await json(c)))),
    )
    .post("/gateway/pair/status", (c) =>
      pairingResponse(c, async () =>
        HostConnection.pairingStatus(
          z
            .object({ requestID: z.string().uuid(), signature: z.string().max(128) })
            .strict()
            .parse(await json(c)),
        ),
      ),
    )
    .all("/gateway/api/*", async (c) => {
      const url = new URL(c.req.url)
      const path = url.pathname.slice(`${gateway}/api`.length) + url.search
      try {
        apiPath(path)
      } catch {
        return c.json(
          { name: "HostConnectionRejected", data: { message: "Connection management requires local access" } },
          403,
        )
      }
      const bytes = await HostConnection.readBody(c.req.raw, maxBody)
      const contentType = c.req.header("content-type") ?? ""
      let hostID: string
      try {
        const proof = c.req.header("x-synergy-host-proof")
        if (!proof || proof.length > 1024) throw new Error("Paired device credentials are required")
        hostID = (
          await HostConnection.authorize(
            HostConnection.Packet.parse(JSON.parse(proof)),
            c.req.method,
            path,
            contentType,
            bytes,
          )
        ).id
      } catch {
        return c.json(
          { name: "Unauthorized", data: { message: "A confirmed pairing and valid request signature are required" } },
          401,
        )
      }
      const headers = new Headers(c.req.raw.headers)
      headers.delete("x-synergy-host-proof")
      headers.delete("authorization")
      headers.delete("host")
      const token = RuntimeContext.current().host.env.SYNERGY_SERVER_TOKEN
      if (token) headers.set("authorization", `Bearer ${token}`)
      headers.set("origin", url.origin)
      const request = new Request(`${url.origin}${path}`, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : bytes,
        signal: c.req.raw.signal,
      })
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
        return HostConnection.withRemote(hostID, () => input.forward(request, c.env))
      const server = ((c.env as { server?: unknown }).server ?? c.env) as Bun.Server<
        Parameters<typeof websocket.open>[0]["data"]
      >
      const transport = Object.create(server) as typeof server
      transport.upgrade = (request, options) => {
        if (!options?.data) return false
        const data = options.data
        const events = data.events
        let dispose: (() => void) | undefined
        return server.upgrade(c.req.raw, {
          ...options,
          data: {
            ...data,
            events: {
              ...events,
              onOpen(event, ws) {
                dispose = HostConnection.watch(hostID, () => ws.close(1008, "Pairing revoked"))
                events.onOpen?.(event, ws)
              },
              onClose(event, ws) {
                dispose?.()
                events.onClose?.(event, ws)
              },
              onError(event, ws) {
                dispose?.()
                events.onError?.(event, ws)
              },
            },
          },
        })
      }
      return HostConnection.withRemote(hostID, () => input.forward(request, { server: transport }))
    })
    .all("/peers/:hostID/proxy/*", async (c) => {
      const peer = await HostConnection.getPeer(z.string().uuid().parse(c.req.param("hostID")))
      if (!peer.url)
        return c.json({ name: "HostConnectionRejected", data: { message: "Destination address is unavailable" } }, 409)
      const incoming = new URL(c.req.url)
      const prefix = `/host-connection/peers/${peer.id}/proxy`
      const path = apiPath(incoming.pathname.slice(prefix.length) + incoming.search)
      const bytes = await HostConnection.readBody(c.req.raw, maxBody)
      const contentType = c.req.header("content-type") ?? ""
      const packet = await HostConnection.signRequest(peer.id, c.req.method, path, contentType, bytes)
      const headers = {
        "x-synergy-host-proof": JSON.stringify(packet),
        ...(contentType ? { "content-type": contentType } : {}),
      }
      const destination = `${HostConnection.address(peer.url)}/api${path}`
      if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
        if (!input.originAllowed(c.req.header("origin"), c.req.url)) return c.text("Origin not allowed", 403)
        return upgradeWebSocket(() => {
          let upstream: WebSocket | undefined
          let client: WSContext | undefined
          let timeout: ReturnType<typeof setTimeout> | undefined
          let dispose: (() => void) | undefined
          const queued: WSMessageReceive[] = []
          let queuedBytes = 0
          const close = () => {
            clearTimeout(timeout)
            dispose?.()
            queued.length = 0
            queuedBytes = 0
            const remote = upstream,
              local = client
            upstream = undefined
            client = undefined
            remote?.close()
            local?.close(1000)
          }
          return {
            onOpen(_event, ws) {
              client = ws
              dispose = HostConnection.watch(peer.id, close)
              upstream = Reflect.construct(WebSocket, [destination.replace(/^http/, "ws"), { headers }]) as WebSocket
              upstream.binaryType = "arraybuffer"
              timeout = setTimeout(close, 10_000)
              upstream.onopen = () => {
                clearTimeout(timeout)
                for (const message of queued) upstream?.send(message)
                queued.length = 0
                queuedBytes = 0
              }
              upstream.onmessage = (event) => {
                if (
                  ((client?.raw as { getBufferedAmount?: () => number } | undefined)?.getBufferedAmount?.() ?? 0) >
                  4 * 1024 * 1024
                )
                  return close()
                client?.send(event.data)
              }
              upstream.onerror = close
              upstream.onclose = close
            },
            onMessage(event) {
              if (upstream?.readyState === WebSocket.CONNECTING) {
                queuedBytes +=
                  typeof event.data === "string"
                    ? Buffer.byteLength(event.data)
                    : event.data instanceof Blob
                      ? event.data.size
                      : event.data.byteLength
                if (queuedBytes > 4 * 1024 * 1024) return close()
                queued.push(event.data)
                return
              }
              if (!upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 4 * 1024 * 1024)
                return close()
              upstream.send(event.data)
            },
            onClose: close,
            onError: close,
          }
        })(c, async () => {})
      }
      const response = await fetch(destination, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : bytes,
        redirect: "error",
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      })
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete("content-encoding")
      responseHeaders.delete("content-length")
      responseHeaders.delete("set-cookie")
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    })
}
