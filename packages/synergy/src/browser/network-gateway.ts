import http from "node:http"
import net from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"

interface OwnerGrant {
  username: string
  password: string
  activeConnections: number
  sockets: Set<net.Socket>
}

interface Gateway {
  server: http.Server
  address: { host: string; port: number }
}

export interface BrowserProxyDescriptor {
  server: string
  username: string
  password: string
}

let gateway: Gateway | null = null
let starting: Promise<Gateway> | null = null
let stopping: Promise<void> | null = null
const grantsByOwner = new Map<string, OwnerGrant>()
const grantsByUsername = new Map<string, OwnerGrant>()
const sockets = new Set<net.Socket>()
const upstreamSockets = new Set<net.Socket>()
const MAX_OWNER_CONNECTIONS = 64
const PROXY_AUTHENTICATE = 'Basic realm="Synergy Browser"'

class BrowserProxyAuthenticationError extends Error {}

export namespace BrowserNetworkGateway {
  export async function proxyFor(owner: BrowserOwner.Info): Promise<BrowserProxyDescriptor> {
    while (true) {
      const current = await ensure()
      if (stopping || gateway !== current) continue

      const ownerKey = BrowserOwner.key(owner)
      let grant = grantsByOwner.get(ownerKey)
      if (!grant) {
        grant = {
          username: randomBytes(16).toString("hex"),
          password: randomBytes(32).toString("hex"),
          activeConnections: 0,
          sockets: new Set(),
        }
        grantsByOwner.set(ownerKey, grant)
        grantsByUsername.set(grant.username, grant)
      }
      return {
        server: `http://${current.address.host}:${current.address.port}`,
        username: grant.username,
        password: grant.password,
      }
    }
  }

  export function revoke(owner: BrowserOwner.Info): void {
    const ownerKey = BrowserOwner.key(owner)
    const grant = grantsByOwner.get(ownerKey)
    grantsByOwner.delete(ownerKey)
    if (!grant) return
    grantsByUsername.delete(grant.username)
    for (const socket of grant.sockets) socket.destroy()
  }

  export function stop(): Promise<void> {
    if (stopping) return stopping
    stopping = stopGateway().finally(() => {
      stopping = null
    })
    return stopping
  }

  async function ensure(): Promise<Gateway> {
    while (true) {
      const pendingStop = stopping
      if (pendingStop) {
        await pendingStop
        continue
      }
      if (gateway) return gateway

      const pendingStart = starting ?? startGateway()
      if (!starting) starting = pendingStart
      let current: Gateway
      try {
        current = await pendingStart
      } finally {
        if (starting === pendingStart) starting = null
      }
      const pendingShutdown = stopping
      if (!pendingShutdown && gateway === current) return current
      if (pendingShutdown) await pendingShutdown
    }
  }
}

async function startGateway(): Promise<Gateway> {
  const next = http.createServer(handleHttp)
  next.on("connect", handleConnect)
  next.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  next.on("clientError", (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    next.once("error", reject)
    next.listen(0, "127.0.0.1", () => resolve())
  })
  const bound = next.address()
  if (!bound || typeof bound === "string") throw new Error("Browser Network Gateway failed to bind.")
  const current = { server: next, address: { host: "127.0.0.1", port: bound.port } }
  gateway = current
  return current
}

async function stopGateway(): Promise<void> {
  const pending = starting
  if (pending) {
    try {
      await pending
    } catch {
      // Failed starts have no bound server to close.
    }
  }

  const active = gateway
  gateway = null
  grantsByOwner.clear()
  grantsByUsername.clear()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const socket of upstreamSockets) socket.destroy()
  upstreamSockets.clear()
  if (!active) return
  await new Promise<void>((resolve) => active.server.close(() => resolve()))
}

async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let release: (() => void) | undefined
  try {
    const grant = authenticate(request.headers["proxy-authorization"])
    release = acquire(grant)
    response.once("close", release)
    const url = new URL(request.url ?? "")
    if (url.protocol !== "http:") invalidTarget("Only HTTP requests and HTTPS CONNECT tunnels are accepted.")
    const target = validateTarget(url.hostname, Number(url.port || 80))
    trackGrantSocket(grant, request.socket)
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    trackUpstreamRequest(grant, upstream)
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Browser proxy upstream timed out.")))
    upstream.on("error", (error) => response.destroy(error))
    request.pipe(upstream)
  } catch (error) {
    release?.()
    const authenticationError = error instanceof BrowserProxyAuthenticationError
    response.writeHead(authenticationError ? 407 : error instanceof BrowserProtocolError ? 403 : 502, {
      "content-type": "text/plain",
      ...(authenticationError ? { "proxy-authenticate": PROXY_AUTHENTICATE } : {}),
    })
    response.end(error instanceof Error ? error.message : "Browser proxy request failed.")
  }
}

async function handleConnect(request: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
  let release: (() => void) | undefined
  try {
    const grant = authenticate(request.headers["proxy-authorization"])
    release = acquire(grant)
    client.once("close", release)
    const target = validateTarget(...splitHostPort(request.url ?? "", 443))
    trackGrantSocket(grant, client)
    const upstream = net.connect({ host: target.hostname, port: target.port })
    trackSocket(grant, upstream)
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.byteLength) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.once("error", () => client.destroy())
  } catch (error) {
    release?.()
    client.end(
      error instanceof BrowserProxyAuthenticationError
        ? `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${PROXY_AUTHENTICATE}\r\nConnection: close\r\n\r\n`
        : "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
    )
  }
}

function acquire(grant: OwnerGrant): () => void {
  if (grant.activeConnections >= MAX_OWNER_CONNECTIONS) {
    throw new BrowserProtocolError({
      code: "browser_network_concurrency_exceeded",
      message: `Browser owner exceeded the ${MAX_OWNER_CONNECTIONS}-connection network limit.`,
      retryable: true,
    })
  }
  grant.activeConnections++
  let released = false
  return () => {
    if (released) return
    released = true
    grant.activeConnections = Math.max(0, grant.activeConnections - 1)
  }
}

function trackUpstreamRequest(grant: OwnerGrant, request: http.ClientRequest): void {
  request.on("socket", (socket) => trackSocket(grant, socket))
}

function trackSocket(grant: OwnerGrant, socket: net.Socket): void {
  upstreamSockets.add(socket)
  socket.once("close", () => upstreamSockets.delete(socket))
  trackGrantSocket(grant, socket)
  socket.setTimeout(30 * 60_000, () => socket.destroy())
}

function trackGrantSocket(grant: OwnerGrant, socket: net.Socket): void {
  grant.sockets.add(socket)
  socket.once("close", () => grant.sockets.delete(socket))
}

function authenticate(header: string | undefined): OwnerGrant {
  if (!header?.startsWith("Basic "))
    throw new BrowserProxyAuthenticationError("Browser proxy authentication is required.")
  const [username, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":", 2)
  const grant = grantsByUsername.get(username ?? "")
  if (!grant || !secureEqual(password ?? "", grant.password)) {
    throw new BrowserProxyAuthenticationError("Invalid Browser proxy credentials.")
  }
  return grant
}

function splitHostPort(value: string, defaultPort: number): [hostname: string, port: number] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    if (end < 0) invalidTarget("Invalid IPv6 proxy target.")
    return [value.slice(1, end), Number(value.slice(end + 2) || defaultPort)]
  }
  const index = value.lastIndexOf(":")
  if (index < 0) return [value, defaultPort]
  return [value.slice(0, index), Number(value.slice(index + 1) || defaultPort)]
}

function validateTarget(hostname: string, port: number): { hostname: string; port: number } {
  const normalized = hostname.replace(/^\[|\]$/g, "").trim()
  if (!normalized || /[\s/\\\0]/.test(normalized)) invalidTarget("The destination hostname is invalid.")
  if (!Number.isInteger(port) || port < 1 || port > 65_535) invalidTarget("The destination port is invalid.")
  return { hostname: normalized, port }
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function invalidTarget(message: string): never {
  throw new BrowserProtocolError({
    code: "browser_network_invalid_target",
    message,
    retryable: false,
    suggestedAction: "Use a valid HTTP or HTTPS destination.",
  })
}
