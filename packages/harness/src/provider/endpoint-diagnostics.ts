import dns from "node:dns/promises"
import net from "node:net"
import tls from "node:tls"
import { classifyNetworkError } from "@ericsanchezok/synergy-util/network-error"
import { withTimeout } from "../util/timeout"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Provider } from "./provider"
import type { SandboxReadinessCheck } from "../sandbox/types"

export interface ProviderEndpoint {
  providerID: string
  url: string
}

export interface ProviderEndpointObservation {
  address?: string
  issuer?: string
}

export interface ProviderEndpointProbe {
  host: string
  port: number
  timeoutMs: number
}

interface ProviderEndpointSource {
  [providerID: string]: {
    options?: Record<string, unknown>
    models?: Record<string, { api?: { url?: string } }>
  }
}

export interface ProviderEndpointOverrides {
  /** Bound for one DNS, TLS, or route probe. */
  timeoutMs?: number
  /** Bound for reading the configured providers before any probe starts. */
  providerTimeoutMs?: number
  listProviders?: () => Promise<ProviderEndpointSource>
  resolve?: (host: string) => Promise<string[]>
  connectTls?: (probe: ProviderEndpointProbe) => Promise<ProviderEndpointObservation>
  readRoutes?: () => Promise<string>
}

interface EndpointTarget extends ProviderEndpoint {
  protocol: string
  host: string
  port: number
}

const ROUTING_ID = "provider-endpoint-routing"
const ROUTING_LABEL = "Provider endpoint routing"
const TLS_ID = "provider-endpoint-tls"
const TLS_LABEL = "Provider endpoint TLS"
const NO_ENDPOINT_DETAIL = "No configured provider endpoints were found, so endpoint routing and TLS were not checked."

const PROBE_TIMEOUT_MS = 4_000
// Matches the catalog fetch budget in provider/models.ts: reading every configured provider
// parses the whole model catalog, which is slower than a single network probe.
const PROVIDER_READ_TIMEOUT_MS = 10_000
const ROUTE_COMMANDS = [
  ["netstat", "-rn"],
  ["ip", "route", "show"],
] as const

// Fake-IP DNS modes and TUN interception proxies (Clash, mihomo, sing-box) hand out addresses
// inside these ranges for names that should resolve publicly. 100.64.0.0/10 is deliberately
// absent because Tailscale serves real endpoints there.
const FABRICATED_RANGES = [
  {
    network: "198.18.0.0",
    prefix: 15,
    label: "198.18.0.0/15, the RFC 2544 benchmarking range that fake-IP DNS proxies allocate",
  },
  { network: "240.0.0.0", prefix: 4, label: "240.0.0.0/4, a reserved range that never routes publicly" },
] as const

// A /1 route always shadows the default route for half of the address space, so its presence
// means half-default interception. OpenVPN-style tunnels install 0.0.0.0/1 plus 128.0.0.0/1,
// while mihomo TUN on macOS covers the lower half with a 1, 2/7, 4/6, 8/5, 16/4, 32/3, 64/2
// cascade and only installs 128.0.0.0/1; both signatures are intercepted traffic.
const HALF_DEFAULT_DESTINATIONS = ["0.0.0.0/1", "128.0.0.0/1"]
const TUNNEL_DEVICE = /^(?:utun|tun|tap)\d+$/
const IPV4_SECTION = /^Internet:$/
const IPV6_SECTION = /^Internet6:$/
const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function check(id: string, label: string, status: SandboxReadinessCheck["status"], detail: string) {
  return { id, label, status, detail } satisfies SandboxReadinessCheck
}

function ipv4(value: string) {
  const octets = value.split(".")
  if (octets.length !== 4) return
  let result = 0
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return
    const parsed = Number(octet)
    if (parsed > 255) return
    result = result * 256 + parsed
  }
  return result >>> 0
}

function padAddress(octets: string[]) {
  const padded = [...octets, ...Array<string>(4 - octets.length).fill("0")].join(".")
  const parsed = ipv4(padded)
  if (parsed === undefined) return
  return { address: padded, value: parsed }
}

function maskPrefix(mask: string) {
  const value = ipv4(mask)
  if (value === undefined) return
  let prefix = 0
  for (let bit = 31; bit >= 0; bit--) {
    if ((value & (2 ** bit)) === 0) break
    prefix++
  }
  const expected = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return expected === value ? prefix : undefined
}

function withinRange(address: number, network: string, prefix: number) {
  const base = ipv4(network)
  if (base === undefined) return false
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) >>> 0 === (base & mask) >>> 0
}

function fabricatedRange(address: string) {
  const parsed = ipv4(address)
  if (parsed === undefined) return
  return FABRICATED_RANGES.find((range) => withinRange(parsed, range.network, range.prefix))
}

export interface ProviderRouteObservation {
  halfDefaultRoutes: string[]
  defaultDevice?: string
}

export function parseProviderRoutes(text: string): ProviderRouteObservation {
  const destinations = new Set<string>()
  let defaultDevice: string | undefined
  // macOS prints one labelled table per family and routinely carries IPv6 defaults on utun*
  // devices from unrelated VPN frameworks, so only IPv4 interception is diagnosed here. Other
  // labels (Linux has none, Windows prints "Active Routes:") leave the current family in place.
  let ipv4 = true
  for (const line of text.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      const label = line.trim()
      if (IPV6_SECTION.test(label)) ipv4 = false
      else if (IPV4_SECTION.test(label)) ipv4 = true
      continue
    }
    if (!ipv4) continue
    const columns = line.trim().split(/\s+/)
    if (columns.length < 3) continue
    if (columns[0] === "default") {
      defaultDevice ??= columns.find((column) => TUNNEL_DEVICE.test(column))
      continue
    }
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){0,3})\/(\d{1,2})$/.exec(columns[0])
    const padded = cidr ? padAddress(cidr[1].split(".")) : undefined
    if (cidr && padded) {
      destinations.add(`${padded.address}/${Number(cidr[2])}`)
      continue
    }
    // Windows netstat prints a destination address plus a separate dotted netmask column.
    const host = /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(columns[0])
    const mask = host ? maskPrefix(columns[1] ?? "") : undefined
    const masked = host ? padAddress(host[1].split(".")) : undefined
    if (masked && mask !== undefined) destinations.add(`${masked.address}/${mask}`)
  }
  return {
    halfDefaultRoutes: HALF_DEFAULT_DESTINATIONS.filter((destination) => destinations.has(destination)),
    defaultDevice,
  }
}

function endpointTargets(endpoints: ProviderEndpoint[]): EndpointTarget[] {
  const targets: EndpointTarget[] = []
  for (const endpoint of endpoints) {
    const url = (() => {
      try {
        return new URL(endpoint.url)
      } catch {
        return undefined
      }
    })()
    if (!url || url.hostname.length === 0) continue
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    targets.push({ ...endpoint, protocol: url.protocol, host: url.hostname, port })
  }
  return targets
}

// Connection identity mirrors retry-coordinator: options.baseURL ?? model.api.url.
export function providerEndpoints(providers: ProviderEndpointSource): ProviderEndpoint[] {
  const seen = new Map<string, ProviderEndpoint>()
  for (const [providerID, provider] of Object.entries(providers)) {
    const baseURL = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : undefined
    for (const model of Object.values(provider.models ?? {})) {
      const url = baseURL ?? model.api?.url
      if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue
      seen.set(url, { providerID, url })
    }
  }
  return [...seen.values()]
}

async function resolveHost(host: string) {
  if (net.isIP(host) !== 0) return [host]
  const records = await dns.lookup(host, { all: true })
  return records.map((record) => record.address)
}

// Certificate verification stays enforced: this probe never sets rejectUnauthorized: false and
// never installs a trusted CA, so an interception certificate surfaces as a failure.
function tlsHandshake(probe: ProviderEndpointProbe) {
  return new Promise<ProviderEndpointObservation>((resolve, reject) => {
    const options: tls.ConnectionOptions = { host: probe.host, port: probe.port }
    if (net.isIP(probe.host) === 0) options.servername = probe.host
    const socket = tls.connect(options)
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`TLS handshake with ${probe.host} timed out after ${probe.timeoutMs}ms`)))
    }, probe.timeoutMs)
    function finish(settle: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      settle()
    }
    socket.once("secureConnect", () => {
      // Read the peer details before finish() destroys the socket, which clears remoteAddress.
      const issuer = socket.getPeerCertificate()?.issuer as Record<string, string> | undefined
      const observation: ProviderEndpointObservation = {
        address: socket.remoteAddress ?? undefined,
        issuer: issuer?.CN ?? issuer?.O ?? issuer?.C,
      }
      finish(() => resolve(observation))
    })
    socket.once("error", (error: Error) => {
      finish(() => reject(error))
    })
  })
}

async function readRouteTable(timeoutMs: number) {
  let lastError: unknown
  for (const command of ROUTE_COMMANDS) {
    try {
      const child = Bun.spawn({ cmd: [...command], stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
      const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`)
      return output
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(errorMessage(lastError))
}

function tlsVerificationFailure(error: unknown) {
  const classification = classifyNetworkError(error)
  if (classification?.category === "tls-verification") return classification.code ?? "certificate verification failed"
  if (classification?.code && CERTIFICATE_CODES.has(classification.code.toUpperCase())) return classification.code
  return undefined
}

async function listProviderEndpoints() {
  return ScopeContext.provide({ scope: Scope.home(), fn: () => Provider.list() })
}

async function routingCheck(
  targets: EndpointTarget[],
  overrides: ProviderEndpointOverrides,
): Promise<SandboxReadinessCheck> {
  const timeoutMs = overrides.timeoutMs ?? PROBE_TIMEOUT_MS
  const hosts = [...new Set(targets.map((target) => target.host))]
  if (hosts.length === 0) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      "No configured provider endpoint could be parsed into a host, so endpoint routing was not checked.",
    )
  }
  const routeTable = await withTimeout((overrides.readRoutes ?? (() => readRouteTable(timeoutMs)))(), timeoutMs, {
    message: "Reading the route table timed out",
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const resolve = overrides.resolve ?? resolveHost
  const unresolved: string[] = []
  const resolutions = await Promise.all(
    hosts.map(async (host) => {
      try {
        const addresses = await withTimeout(resolve(host), timeoutMs, { message: `Resolving ${host} timed out` })
        if (addresses.length === 0) unresolved.push(`${host} (no addresses returned)`)
        return { host, addresses }
      } catch (error) {
        unresolved.push(`${host} (${errorMessage(error)})`)
        return { host, addresses: [] as string[] }
      }
    }),
  )

  const flagged = resolutions.flatMap((resolution) =>
    resolution.addresses.flatMap((address) => {
      const range = fabricatedRange(address)
      return range ? [`${resolution.host} resolved to ${address}, inside ${range.label}`] : []
    }),
  )
  if (flagged.length > 0) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      `${flagged.join("; ")}. A fake-IP DNS mode or TUN interception is handling provider traffic and can break TLS handshakes; exclude these endpoints from the proxy.`,
    )
  }

  if (!routeTable.ok) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      `${resolutions.length} provider endpoint(s) resolved outside fake-IP and reserved ranges, but the route table could not be read (${errorMessage(routeTable.error)}), so interception was not ruled out.`,
    )
  }
  const routes = parseProviderRoutes(routeTable.value)
  if (routes.halfDefaultRoutes.length > 0) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      `Half-default route(s) ${routes.halfDefaultRoutes.join(", ")} are installed, so provider traffic is forwarded into a tunnel${routes.defaultDevice ? ` (default device ${routes.defaultDevice})` : ""}. A TUN proxy or full-tunnel VPN is intercepting connections and can break TLS handshakes.`,
    )
  }
  if (routes.defaultDevice) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      `The default route is bound to tunnel device ${routes.defaultDevice}, so provider traffic is intercepted and can break TLS handshakes.`,
    )
  }
  if (unresolved.length > 0) {
    return check(
      ROUTING_ID,
      ROUTING_LABEL,
      "warn",
      `${resolutions.length - unresolved.length} of ${hosts.length} provider endpoint host(s) resolved outside fake-IP and reserved ranges, but resolution failed for ${unresolved.join(", ")}, so interception was not ruled out.`,
    )
  }
  return check(
    ROUTING_ID,
    ROUTING_LABEL,
    "pass",
    `${hosts.length} provider endpoint host(s) resolved outside fake-IP and reserved ranges, and no half-default or tunnel-bound default route is present.`,
  )
}

async function tlsCheck(
  targets: EndpointTarget[],
  overrides: ProviderEndpointOverrides,
): Promise<SandboxReadinessCheck> {
  const timeoutMs = overrides.timeoutMs ?? PROBE_TIMEOUT_MS
  const secure = targets.filter((target) => target.protocol === "https:")
  if (secure.length === 0) {
    return check(
      TLS_ID,
      TLS_LABEL,
      "warn",
      targets.length === 0
        ? "No configured provider endpoint could be parsed, so no TLS handshake was checked."
        : `No configured provider endpoint uses HTTPS (${targets.length} non-TLS endpoint(s)), so no TLS handshake was checked.`,
    )
  }

  const connect = overrides.connectTls ?? tlsHandshake
  const probes = await Promise.all(
    secure.map(async (target) => {
      try {
        const observation = await withTimeout(connect({ host: target.host, port: target.port, timeoutMs }), timeoutMs, {
          message: `TLS handshake with ${target.host} timed out after ${timeoutMs}ms`,
        })
        return { host: target.host, observation }
      } catch (error) {
        return { host: target.host, error }
      }
    }),
  )

  const failures = probes.flatMap((probe) => {
    const reason = probe.error === undefined ? undefined : tlsVerificationFailure(probe.error)
    return reason ? [`${probe.host} (${reason})`] : []
  })
  if (failures.length > 0) {
    return check(
      TLS_ID,
      TLS_LABEL,
      "fail",
      `TLS verification failed for ${failures.join(", ")}. An interception certificate or a broken proxy handshake is in the path; Synergy keeps certificate verification enforced and does not trust intercepted certificates.`,
    )
  }

  const verified = probes.filter((probe) => probe.error === undefined)
  const incomplete = probes.filter((probe) => probe.error !== undefined)
  if (incomplete.length > 0) {
    return check(
      TLS_ID,
      TLS_LABEL,
      "warn",
      `TLS handshake did not complete for ${incomplete
        .map((probe) => `${probe.host} (${errorMessage(probe.error)})`)
        .join(", ")}${verified.length > 0 ? `; ${verified.length} other endpoint(s) completed a handshake` : ""}.`,
    )
  }
  return check(
    TLS_ID,
    TLS_LABEL,
    "pass",
    verified
      .map(
        (probe) =>
          `${probe.host} completed a TLS handshake with a certificate issued by "${probe.observation?.issuer ?? "an unspecified issuer"}", resolved to ${probe.observation?.address ?? "an unspecified address"}`,
      )
      .join("; ") + ".",
  )
}

export async function providerEndpointChecks(input: {
  endpoints: ProviderEndpoint[]
  overrides?: ProviderEndpointOverrides
}): Promise<SandboxReadinessCheck[]> {
  if (input.endpoints.length === 0) {
    return [
      check(ROUTING_ID, ROUTING_LABEL, "warn", NO_ENDPOINT_DETAIL),
      check(TLS_ID, TLS_LABEL, "warn", NO_ENDPOINT_DETAIL),
    ]
  }
  const overrides = input.overrides ?? {}
  const targets = endpointTargets(input.endpoints)
  const [routing, tls] = await Promise.all([
    routingCheck(targets, overrides).catch((error) =>
      check(
        ROUTING_ID,
        ROUTING_LABEL,
        "warn",
        `Provider endpoint routing could not be checked (${errorMessage(error)}).`,
      ),
    ),
    tlsCheck(targets, overrides).catch((error) =>
      check(TLS_ID, TLS_LABEL, "warn", `Provider endpoint TLS could not be checked (${errorMessage(error)}).`),
    ),
  ])
  return [routing, tls]
}

export async function getProviderEndpointChecks(
  overrides: ProviderEndpointOverrides = {},
): Promise<SandboxReadinessCheck[]> {
  try {
    const providers = await withTimeout(
      (overrides.listProviders ?? listProviderEndpoints)(),
      overrides.providerTimeoutMs ?? PROVIDER_READ_TIMEOUT_MS,
      { message: "Reading configured providers timed out" },
    )
    return await providerEndpointChecks({ endpoints: providerEndpoints(providers), overrides })
  } catch (error) {
    return [
      check(
        ROUTING_ID,
        ROUTING_LABEL,
        "warn",
        `Configured provider endpoints could not be read (${errorMessage(error)}), so endpoint routing was not checked.`,
      ),
      check(
        TLS_ID,
        TLS_LABEL,
        "warn",
        `Configured provider endpoints could not be read (${errorMessage(error)}), so TLS was not checked.`,
      ),
    ]
  }
}
