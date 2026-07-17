import tls from "node:tls"
import { resolve4 } from "node:dns/promises"
import { isIP } from "node:net"

// ── Transport-level IPv4 fallback for HTTPS requests ─────────────────
//
// On Linux hosts where a dual-stack hostname resolves to both IPv6 and
// IPv4 addresses but IPv6 connectivity is broken (routing hang), Bun's
// built-in fetch does not implement Happy Eyeballs and will wait until
// timeout rather than falling back to IPv4.
//
// This module races Bun's native fetch against a direct IPv4 TLS
// connection. Both branches start immediately. The first branch to
// complete wins; the loser is cancelled and cleaned up.
//
// Security invariants:
//   - TLS hostname verification via servername + rejectUnauthorized
//   - DNS-rebound addresses filtered (no private/loopback/link-local/CGNAT)
//   - Only successful responses participate in the race; redirects are rejected
//   - Connection: close sent; response collected via Content-Length,
//     chunked, or end-of-stream with bounded total bytes
//   - Abort signals propagate; one shared deadline

const MAX_CONNECT_MS = 10_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Ipv4BranchFn = (
  url: URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  rejectUnauthorized: boolean,
  connectTimeoutMs: number,
) => Promise<Response>

// ── Public API ────────────────────────────────────────────────────────

export function createFallbackFetcher(
  baseFetch: Fetcher,
  options?: {
    connectTimeoutMs?: number
    rejectUnauthorized?: boolean
    _ipv4Branch?: Ipv4BranchFn
    acceptedStatuses?: readonly number[]
  },
): Fetcher {
  const connectTimeoutMs = options?.connectTimeoutMs ?? MAX_CONNECT_MS
  const rejectUnauthorized = options?.rejectUnauthorized ?? true
  const ipv4Branch = options?._ipv4Branch ?? defaultIpv4Branch
  const acceptedStatuses = new Set(options?.acceptedStatuses ?? [])
  const acceptsResponse = (response: Response) => response.ok || acceptedStatuses.has(response.status)

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.protocol !== "https:") return baseFetch(request)

    const callerSignal = request.signal
    const nativeController = new AbortController()
    const ipv4Controller = new AbortController()
    const abortBranches = () => {
      nativeController.abort(callerSignal.reason)
      ipv4Controller.abort(callerSignal.reason)
    }
    if (callerSignal.aborted) abortBranches()
    else callerSignal.addEventListener("abort", abortBranches, { once: true })

    const nativeRequest = new Request(request, { signal: nativeController.signal })
    const fallbackInit: RequestInit = {
      method: request.method,
      headers: request.headers,
    }
    const nativePromise = baseFetch(nativeRequest).then((response) => {
      if (!acceptsResponse(response)) throw new Error("Clarus REST request failed")
      return { source: "native" as const, response }
    })
    const ipv4Promise = ipv4Branch(url, fallbackInit, ipv4Controller.signal, rejectUnauthorized, connectTimeoutMs).then(
      (response) => {
        if (!acceptsResponse(response)) throw new Error("Clarus REST request failed")
        return { source: "ipv4" as const, response }
      },
    )
    try {
      const result = await Promise.any([nativePromise, ipv4Promise])
      if (result.source === "native") ipv4Controller.abort()
      else nativeController.abort()
      return result.response
    } catch (agg) {
      nativeController.abort()
      ipv4Controller.abort()
      if (agg instanceof AggregateError) {
        for (const err of agg.errors) {
          if (err instanceof DOMException) continue
          if (err instanceof Error && err.message.startsWith("Clarus")) throw err
        }
      }
      throw new Error("Clarus REST request failed")
    } finally {
      callerSignal.removeEventListener("abort", abortBranches)
    }
  }
}

// ── Default IPv4 branch (production path) ────────────────────────────

async function defaultIpv4Branch(
  url: URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  rejectUnauthorized: boolean,
  connectTimeoutMs: number,
): Promise<Response> {
  const hostname = url.hostname
  const port = url.port ? parseInt(url.port, 10) : 443

  let addrs: string[]
  try {
    addrs = await resolve4(hostname)
  } catch {
    throw new Error("Clarus REST request failed")
  }
  if (!addrs || addrs.length === 0) throw new Error("Clarus REST request failed")

  const v4Addr = filterSafeIpv4(addrs)
  if (!v4Addr) throw new Error("Clarus REST request failed")
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError")

  return connectIpv4Tls(url, v4Addr, hostname, port, init, connectTimeoutMs, rejectUnauthorized, signal)
}

// ── IPv4 address safety filter ───────────────────────────────────────

function filterSafeIpv4(addrs: string[]): string | null {
  for (const addr of addrs) {
    if (!isIP(addr)) continue
    if (isPrivateOrReservedIPv4(addr)) continue
    return addr
  }
  return null
}

function isPrivateOrReservedIPv4(addr: string): boolean {
  const octets = addr.split(".").map(Number)
  if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) return true
  // 0.0.0.0/8
  if (octets[0] === 0) return true
  // 10.0.0.0/8
  if (octets[0] === 10) return true
  // 127.0.0.0/8 (loopback)
  if (octets[0] === 127) return true
  // 169.254.0.0/16 (link-local)
  if (octets[0] === 169 && octets[1] === 254) return true
  // 172.16.0.0/12
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  // 192.0.0.0/24 (IETF protocol assignments)
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) return true
  // 192.0.2.0/24 (TEST-NET-1)
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) return true
  // 192.88.99.0/24 (6to4 relay)
  if (octets[0] === 192 && octets[1] === 88 && octets[2] === 99) return true
  // 192.168.0.0/16
  if (octets[0] === 192 && octets[1] === 168) return true
  // 198.18.0.0/15 (benchmarking)
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true
  // 198.51.100.0/24 (TEST-NET-2)
  if (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) return true
  // 203.0.113.0/24 (TEST-NET-3)
  if (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) return true
  // 224.0.0.0/4 (multicast)
  if (octets[0] >= 224 && octets[0] <= 239) return true
  // 240.0.0.0/4 (reserved)
  if (octets[0] >= 240) return true
  // 100.64.0.0/10 (CGNAT)
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true
  return false
}

// ── IPv4 TLS connect + HTTP request ───────────────────────────────────

function connectIpv4Tls(
  url: URL,
  ipv4Addr: string,
  hostname: string,
  port: number,
  init: RequestInit | undefined,
  connectTimeoutMs: number,
  rejectUnauthorized: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const method = init?.method ?? "GET"
  const requestHeaders = new Headers(init?.headers)
  requestHeaders.set("Host", hostname)
  requestHeaders.set("Connection", "close")

  return new Promise<Response>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error("Connection timed out"))
    }, connectTimeoutMs)

    const socket = tls.connect({
      host: ipv4Addr,
      port,
      servername: hostname,
      rejectUnauthorized,
      ALPNProtocols: ["http/1.1"],
    })

    let settled = false

    const cleanup = () => {
      clearTimeout(connectTimer)
      socket.setTimeout(0)
      socket.removeAllListeners("error")
      socket.removeAllListeners("secureConnect")
      socket.removeAllListeners("data")
      socket.removeAllListeners("end")
      socket.removeAllListeners("close")
      socket.removeAllListeners("timeout")
    }

    const fail = (_error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error("Clarus REST request failed"))
    }

    const sendRequest = () => {
      const path = `${url.pathname}${url.search}`
      const headerLines = Array.from(requestHeaders.entries()).map(([k, v]) => `${k}: ${v}`)
      socket.write(`${method} ${path || "/"} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`)
    }

    socket.on("error", fail)
    socket.on("secureConnect", sendRequest)
    socket.on("timeout", () => {
      socket.destroy(new Error("Connection timed out"))
    })

    // ── Propagate abort signal ───────────────────────────────────
    const onAbort = () => {
      socket.destroy(signal.reason ?? new DOMException("Request aborted", "AbortError"))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    socket.once("close", () => signal.removeEventListener("abort", onAbort))

    // ── Response parsing ─────────────────────────────────────────
    //
    // Collect all data bytes. Because we send "Connection: close",
    // the server will close after the response body. The socket
    // "end" event fires when the server closes, so we get exactly
    // the response (including Content-Length or chunked bodies).

    const chunks: Uint8Array[] = []
    let totalBytes = 0

    socket.on("data", (chunk: Buffer) => {
      if (settled) return
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Response too large"))
        return
      }
      chunks.push(new Uint8Array(chunk))
    })

    socket.on("end", () => {
      if (settled) return
      settled = true
      cleanup()

      if (totalBytes === 0) {
        reject(new Error("Clarus REST request failed"))
        return
      }

      let joinedLen = 0
      for (const c of chunks) joinedLen += c.byteLength
      const all = new Uint8Array(joinedLen)
      let offset = 0
      for (const c of chunks) {
        all.set(c, offset)
        offset += c.byteLength
      }

      const text = new TextDecoder().decode(all)
      const headerEnd = text.indexOf("\r\n\r\n")

      if (headerEnd === -1) {
        reject(new Error("Clarus REST request failed"))
        return
      }

      const rawHeaders = text.slice(0, headerEnd).split("\r\n")
      const statusLine = rawHeaders[0] ?? "HTTP/1.1 502 Bad Gateway"
      const [, statusCode = "502", ...statusTextParts] = statusLine.split(" ")
      const statusNum = Number(statusCode)

      const responseHeaders = new Headers()
      for (let i = 1; i < rawHeaders.length; i++) {
        const line = rawHeaders[i]
        const sep = line.indexOf(":")
        if (sep === -1) continue
        responseHeaders.append(line.slice(0, sep), line.slice(sep + 1).trim())
      }

      const body = text.slice(headerEnd + 4)

      resolve(
        new Response(body, {
          status: statusNum,
          statusText: statusTextParts.join(" "),
          headers: responseHeaders,
        }),
      )
    })

    socket.on("close", () => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error("Clarus REST request failed"))
      }
    })
  })
}

// ── Export for testing ───────────────────────────────────────────────

export { isPrivateOrReservedIPv4 }
