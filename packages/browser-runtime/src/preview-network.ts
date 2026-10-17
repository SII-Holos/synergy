import { lookup } from "node:dns/promises"
import { Agent as HTTPAgent, request as httpRequest } from "node:http"
import { Agent as HTTPSAgent, request as httpsRequest } from "node:https"
import { connect, isIP, type Socket } from "node:net"
import { checkServerIdentity, connect as connectTLS, type PeerCertificate } from "node:tls"
import { BrowserPreviewFailure } from "./preview-types"

export const BROWSER_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
export const BROWSER_PREVIEW_ADDRESS_PROVENANCE = [
  "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml",
  "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml",
] as const

export interface BrowserPreviewConnection {
  address: string
  family: 4 | 6
  port: number
  servername: string
  tls: boolean
  signal: AbortSignal
}

export interface BrowserPreviewOptions {
  signal?: AbortSignal
  timeoutMs?: number
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  connect?: (target: BrowserPreviewConnection) => Socket
  certificateAuthority?: string
}

export function previewURL(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new BrowserPreviewFailure("invalid_url")
  }
  if (
    !/^https?:\/\//i.test(input) ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    /^[^:]+:\/\/[^/?#]*@/.test(input)
  )
    throw new BrowserPreviewFailure("invalid_url")
  for (const key of url.searchParams.keys()) {
    if (
      /^(?:token|access_token|refresh_token|id_token|api[_-]?key|authorization|password|passwd|secret|signature|sig|credential|x-amz-.+|x-goog-.+)$/i.test(
        key,
      )
    ) {
      throw new BrowserPreviewFailure("authentication_required")
    }
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  const family = isIP(hostname)
  if (
    family
      ? !publicAddress(hostname)
      : !hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|onion)$/.test(hostname)
  )
    throw new BrowserPreviewFailure("blocked_address")
  url.hash = ""
  return url
}

function publicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [first, second, third] = address.split(".").map(Number)
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 &&
        (second === 168 || (second === 0 && (third === 0 || third === 2)) || (second === 88 && third === 99))) ||
      (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
      (first === 203 && second === 0 && third === 113) ||
      address === "168.63.129.16"
    )
  }
  if (family !== 6 || address.includes("%")) return false
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [first, second] = normalized.split(":").map((part) => Number.parseInt(part || "0", 16))
  return (
    (first & 0xe000) === 0x2000 &&
    !(
      (first === 0x2001 && (second < 0x200 || second === 0xdb8)) ||
      first === 0x2002 ||
      (first === 0x3fff && second < 0x1000)
    )
  )
}

async function pinnedAddress(
  url: URL,
  options: BrowserPreviewOptions,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) return { address: hostname, family: literalFamily }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await abortable(
      (options.lookup ?? ((host) => lookup(host, { all: true, verbatim: true })))(hostname),
      signal,
    )
  } catch {
    signal.throwIfAborted()
    throw new BrowserPreviewFailure("dns_failed")
  }
  signal.throwIfAborted()
  if (!addresses.length) throw new BrowserPreviewFailure("dns_failed")
  if (addresses.some((entry) => isIP(entry.address) !== entry.family || !publicAddress(entry.address))) {
    throw new BrowserPreviewFailure("blocked_address")
  }
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]
  return { address: address.address, family: address.family as 4 | 6 }
}

export async function requestPreview(
  url: URL,
  source: boolean,
  options: BrowserPreviewOptions,
  signal: AbortSignal,
): Promise<{ status: number; location?: string; bytes: Uint8Array }> {
  signal.throwIfAborted()
  const pin = await pinnedAddress(url, options, signal)
  signal.throwIfAborted()
  const secure = url.protocol === "https:"
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const target: BrowserPreviewConnection = {
    ...pin,
    port: Number(url.port || (secure ? 443 : 80)),
    servername: hostname,
    tls: secure,
    signal,
  }
  const agent = secure ? new HTTPSAgent({ keepAlive: false }) : new HTTPAgent({ keepAlive: false })
  Object.assign(agent, {
    createConnection: () => {
      signal.throwIfAborted()
      const socket =
        options.connect?.(target) ?? connect({ host: pin.address, family: pin.family, port: target.port, signal })
      if (!secure) return socket
      return connectTLS({
        socket,
        servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
        ca: options.certificateAuthority,
        checkServerIdentity: (_hostname: string, certificate: PeerCertificate) =>
          checkServerIdentity(hostname, certificate),
      })
    },
  })
  try {
    return await new Promise((resolve, reject) => {
      const request = (secure ? httpsRequest : httpRequest)(
        {
          hostname: pin.address,
          family: pin.family,
          port: target.port,
          method: "GET",
          path: url.pathname + url.search,
          headers: {
            Host: url.host,
            Accept: source ? "text/plain" : "text/html, application/xhtml+xml",
            "Accept-Encoding": "identity",
            "User-Agent": "Synergy-Preview/1.0",
          },
          agent,
          signal,
          maxHeaderSize: 16 * 1024,
        },
        (response) => {
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            resolve({ status, location: response.headers.location, bytes: new Uint8Array() })
            response.destroy()
            return
          }
          const encoding = response.headers["content-encoding"]?.toLowerCase()
          const type = response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() ?? ""
          const failure =
            encoding && encoding !== "identity"
              ? "unsupported_encoding"
              : Number(response.headers["content-length"]) > BROWSER_PREVIEW_MAX_BYTES
                ? "too_large"
                : !(source
                      ? type.startsWith("text/") && !type.includes("html")
                      : ["text/html", "application/xhtml+xml"].includes(type))
                  ? "non_text"
                  : undefined
          if (failure) {
            reject(new BrowserPreviewFailure(failure))
            response.destroy()
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength
            if (total > BROWSER_PREVIEW_MAX_BYTES) {
              reject(new BrowserPreviewFailure("too_large"))
              response.destroy()
            } else chunks.push(chunk)
          })
          response.on("error", reject)
          response.on("aborted", () => reject(new BrowserPreviewFailure("network_error")))
          response.on("end", () => resolve({ status, bytes: Buffer.concat(chunks, total) }))
        },
      )
      request.on("error", reject)
      request.end()
    })
  } finally {
    agent.destroy()
  }
}

function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
