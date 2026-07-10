import dns from "node:dns/promises"
import http from "node:http"
import net from "node:net"
import { isIP } from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"
import { BrowserPolicy } from "./policy.js"

interface OwnerGrant {
  username: string
  password: string
  privateTargets: Map<string, true>
  activeConnections: number
  sockets: Set<net.Socket>
}

export interface BrowserPrivateNetworkGrant {
  hostname: string
  port: number
  addresses: string[]
}

export interface BrowserProxyDescriptor {
  server: string
  username: string
  password: string
}

let server: http.Server | null = null
let address: { host: string; port: number } | null = null
const grants = new Map<string, OwnerGrant>()
const privateTargets = new Map<string, Map<string, true>>()
const sockets = new Set<net.Socket>()
const upstreamSockets = new Set<net.Socket>()
const MAX_OWNER_CONNECTIONS = 64
const METADATA_ADDRESSES = new Set(["169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254"])

export namespace BrowserNetworkGateway {
  export async function proxyFor(owner: BrowserOwner.Info): Promise<BrowserProxyDescriptor> {
    await ensure()
    const key = BrowserOwner.key(owner)
    let grant = grants.get(key)
    if (!grant) {
      grant = {
        username: randomBytes(16).toString("hex"),
        password: randomBytes(32).toString("hex"),
        privateTargets: new Map(privateTargets.get(key)),
        activeConnections: 0,
        sockets: new Set(),
      }
      grants.set(key, grant)
    }
    return { server: `http://${address!.host}:${address!.port}`, username: grant.username, password: grant.password }
  }

  export function allowPrivateNetwork(owner: BrowserOwner.Info, target: BrowserPrivateNetworkGrant): void {
    const key = BrowserOwner.key(owner)
    const targets = privateTargets.get(key) ?? new Map<string, true>()
    addPrivateTargets(targets, target)
    privateTargets.set(key, targets)
    const grant = grants.get(key)
    if (grant) addPrivateTargets(grant.privateTargets, target)
  }

  export function revoke(owner: BrowserOwner.Info): void {
    const key = BrowserOwner.key(owner)
    const grant = grants.get(key)
    grants.delete(key)
    privateTargets.delete(key)
    for (const socket of grant?.sockets ?? []) socket.destroy()
  }

  export async function privateNetworkGrant(input: string): Promise<BrowserPrivateNetworkGrant | null> {
    const url = new URL(input)
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    const hostname = normalizeHostname(url.hostname)
    const records = isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true })
    const addresses: string[] = []
    for (const record of records) {
      validateIP(record.address, port, true)
      if (isPrivateAddress(record.address)) addresses.push(normalizeIPv4Mapped(record.address).toLowerCase())
    }
    return addresses.length ? { hostname, port, addresses: Array.from(new Set(addresses)) } : null
  }

  export async function stop(): Promise<void> {
    const active = server
    server = null
    address = null
    grants.clear()
    privateTargets.clear()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    for (const socket of upstreamSockets) socket.destroy()
    upstreamSockets.clear()
    if (!active) return
    await new Promise<void>((resolve) => active.close(() => resolve()))
  }

  export async function assertAddressAllowed(
    hostname: string,
    port: number,
    privateGrants: readonly BrowserPrivateNetworkGrant[] = [],
  ): Promise<string> {
    const targets = new Map<string, true>()
    for (const grant of privateGrants) addPrivateTargets(targets, grant)
    return resolveAddress(hostname, port, targets)
  }

  async function ensure(): Promise<void> {
    if (server && address) return
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
    server = next
    address = { host: "127.0.0.1", port: bound.port }
  }
}

async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let release: (() => void) | undefined
  try {
    const grant = authenticate(request.headers["proxy-authorization"])
    release = acquire(grant)
    response.once("close", release)
    const url = new URL(request.url ?? "")
    if (url.protocol !== "http:") deny(url.hostname, "Only HTTP requests and HTTPS CONNECT tunnels are accepted.")
    const port = Number(url.port || 80)
    const ip = await resolveAddress(url.hostname, port, grant.privateTargets)
    trackGrantSocket(grant, request.socket)
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    const upstream = http.request(
      { host: ip, port, method: request.method, path: `${url.pathname}${url.search}`, headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on("socket", (socket) => {
      upstreamSockets.add(socket)
      socket.once("close", () => upstreamSockets.delete(socket))
      trackGrantSocket(grant, socket)
    })
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Browser proxy upstream timed out.")))
    upstream.on("error", (error) => response.destroy(error))
    request.pipe(upstream)
  } catch (error) {
    release?.()
    response.writeHead(error instanceof BrowserProtocolError ? 403 : 502, { "content-type": "text/plain" })
    response.end(error instanceof Error ? error.message : "Browser proxy request failed.")
  }
}

async function handleConnect(request: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
  let release: (() => void) | undefined
  try {
    const grant = authenticate(request.headers["proxy-authorization"])
    release = acquire(grant)
    client.once("close", release)
    const target = splitHostPort(request.url ?? "", 443)
    const ip = await resolveAddress(target.hostname, target.port, grant.privateTargets)
    trackGrantSocket(grant, client)
    const upstream = net.connect({ host: ip, port: target.port })
    trackGrantSocket(grant, upstream)
    upstreamSockets.add(upstream)
    upstream.once("close", () => upstreamSockets.delete(upstream))
    upstream.setTimeout(30 * 60_000, () => upstream.destroy())
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.byteLength) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.once("error", () => client.destroy())
  } catch {
    release?.()
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
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

async function resolveAddress(hostname: string, port: number, targets: ReadonlyMap<string, true>): Promise<string> {
  const normalized = normalizeHostname(hostname)
  if (normalized === "metadata.google.internal" || normalized.endsWith(".metadata.google.internal")) {
    deny(hostname, "Cloud metadata endpoints are blocked.")
  }
  let records: Array<{ address: string; family: number }>
  try {
    records = isIP(normalized)
      ? [{ address: normalized, family: isIP(normalized) }]
      : await dns.lookup(normalized, { all: true, verbatim: true })
  } catch {
    deny(hostname, "DNS resolution failed.")
  }
  if (records.length === 0) deny(hostname, "DNS returned no addresses.")
  for (const record of records) {
    validateIP(record.address, port, targets.has(privateTargetKey(normalized, port, record.address)))
  }
  return records[0].address
}

function trackGrantSocket(grant: OwnerGrant, socket: net.Socket): void {
  grant.sockets.add(socket)
  socket.once("close", () => grant.sockets.delete(socket))
}

function authenticate(header: string | undefined): OwnerGrant {
  if (!header?.startsWith("Basic ")) throw new Error("Browser proxy authentication is required.")
  const [username, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":", 2)
  for (const grant of grants.values()) {
    if (secureEqual(username ?? "", grant.username) && secureEqual(password ?? "", grant.password)) return grant
  }
  throw new Error("Invalid Browser proxy credentials.")
}

function validateIP(input: string, port: number, privateNetwork: boolean): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) deny(input, "The destination port is invalid.")
  const ip = normalizeIPv4Mapped(input)
  if (METADATA_ADDRESSES.has(ip.toLowerCase())) deny(ip, "Cloud metadata endpoints are blocked.")
  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number)
    const [a, b] = parts
    if (
      a === 0 ||
      a >= 224 ||
      (a === 100 && b === 100) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    )
      deny(ip, "Unspecified, metadata, benchmark, documentation, multicast, and reserved addresses are blocked.")
    if (a === 169 && b === 254) deny(ip, "Link-local addresses are blocked.")
    if (a === 127) {
      if (!BrowserPolicy.LOCALHOST_ALLOW_PORTS.includes(port))
        deny(ip, `Localhost port ${port} is not an approved development port.`)
      return
    }
    const privateAddress =
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    if (privateAddress && !privateNetwork)
      deny(ip, "Private-network access requires browser_private_network capability.")
    return
  }
  const lower = ip.toLowerCase()
  if (
    lower === "::" ||
    lower === "::ffff:0:0" ||
    lower.startsWith("ff") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    deny(ip, "Unspecified, multicast, and link-local IPv6 addresses are blocked.")
  }
  if (lower === "::1") {
    if (!BrowserPolicy.LOCALHOST_ALLOW_PORTS.includes(port))
      deny(ip, `Localhost port ${port} is not an approved development port.`)
    return
  }
  if ((lower.startsWith("fc") || lower.startsWith("fd")) && !privateNetwork) {
    deny(ip, "Private-network access requires browser_private_network capability.")
  }
  if (lower.startsWith("2001:db8")) deny(ip, "Documentation and reserved IPv6 addresses are blocked.")
}

function isPrivateAddress(input: string): boolean {
  const ip = normalizeIPv4Mapped(input)
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number)
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    )
  }
  const lower = ip.toLowerCase()
  return lower.startsWith("fc") || lower.startsWith("fd")
}

function splitHostPort(value: string, defaultPort: number): { hostname: string; port: number } {
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    if (end < 0) throw new Error("Invalid IPv6 proxy target.")
    return { hostname: value.slice(1, end), port: Number(value.slice(end + 2) || defaultPort) }
  }
  const index = value.lastIndexOf(":")
  if (index < 0) return { hostname: value, port: defaultPort }
  return { hostname: value.slice(0, index), port: Number(value.slice(index + 1) || defaultPort) }
}

function normalizeIPv4Mapped(ip: string): string {
  return ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

function privateTargetKey(hostname: string, port: number, address: string): string {
  return `${normalizeHostname(hostname)}:${port}:${normalizeIPv4Mapped(address).toLowerCase()}`
}

function addPrivateTargets(targets: Map<string, true>, grant: BrowserPrivateNetworkGrant): void {
  for (const address of grant.addresses) targets.set(privateTargetKey(grant.hostname, grant.port, address), true)
  while (targets.size > 128) {
    const oldest = targets.keys().next().value
    if (typeof oldest !== "string") break
    targets.delete(oldest)
  }
}

function isIPv4(ip: string): boolean {
  return isIP(ip) === 4
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function deny(host: string, reason: string): never {
  throw new BrowserProtocolError({
    code: "browser_network_denied",
    message: `Browser connection to ${host} was denied: ${reason}`,
    retryable: false,
    suggestedAction: reason,
  })
}
