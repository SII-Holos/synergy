import { execFileSync } from "node:child_process"
import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"

type Group = "general" | "scoped" | "service-specific"
type Block = { group: Group; domain?: string; port: number; servers: string[] }
function endpoint(value: string, fallbackPort = 53) {
  let address = value,
    port = fallbackPort
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  const ipv4Port = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(value)
  if (bracket) {
    address = bracket[1]
    port = bracket[2] ? Number(bracket[2]) : fallbackPort
  } else if (ipv4Port) {
    address = ipv4Port[1]
    port = Number(ipv4Port[2])
  }
  const family = isIP(address)
  if (!family || !Number.isInteger(port) || port < 1 || port > 65535) return
  try {
    const normalized = family === 6 ? new URL(`http://[${address}]/`).hostname : address
    return `${normalized}:${port}`
  } catch {
    return
  }
}
function same(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

// Provenance: https://github.com/apple-oss-distributions/configd/blob/585b7f2fca293f4642d21d15c5daf187f63c4796/dnsinfo/dnsinfo_logging.h
// Only configuration summaries escape this function; server/domain values remain operation-local.
export function summarizeCrossOSResolverRoute(text: string, servers: string[] | undefined, hostname: string) {
  let parseComplete = typeof text === "string" && Buffer.byteLength(text) <= 65536
  const blocks: Block[] = []
  const groups = new Set<Group>()
  let group: Group | undefined,
    block: Block | undefined,
    noConfiguration = false
  if (parseComplete)
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      if (line === "No DNS configuration available") {
        if (noConfiguration || groups.size || blocks.length) parseComplete = false
        noConfiguration = true
        continue
      }
      const header = new Map<string, Group>([
        ["DNS configuration", "general"],
        ["DNS configuration (for scoped queries)", "scoped"],
        ["DNS configuration (for service-specific queries)", "service-specific"],
      ]).get(line)
      if (header) {
        if (noConfiguration || groups.has(header)) parseComplete = false
        groups.add(header)
        group = header
        block = undefined
        continue
      }
      const resolver = /^resolver #(\d+)$/.exec(line)
      if (resolver) {
        if (
          !group ||
          blocks.length >= 64 ||
          Number(resolver[1]) !== blocks.filter((value) => value.group === group).length + 1
        ) {
          parseComplete = false
          break
        }
        block = { group, port: 53, servers: [] }
        blocks.push(block)
        continue
      }
      const field = /^([^:]+?)\s*:\s*(.*)$/.exec(line)
      if (!block || !field) {
        parseComplete = false
        continue
      }
      const key = field[1].trim(),
        value = field[2]
      if (key === "domain") {
        if (block.domain !== undefined || !/^[a-z0-9_.-]{1,253}$/i.test(value)) parseComplete = false
        block.domain = value.toLowerCase().replace(/\.$/, "")
      } else if (/^nameserver\[\d+\]$/.test(key)) {
        if (block.servers.length >= 32 || key !== `nameserver[${block.servers.length}]`) {
          parseComplete = false
          continue
        }
        block.servers.push(value)
      } else if (key === "port") {
        block.port = Number(value)
        if (!/^\d+$/.test(value) || block.port < 1 || block.port > 65535) parseComplete = false
      } else if (!/^(?:search domain\[\d+\]|options|timeout|if_index|service_identifier|flags|reach|order)$/.test(key))
        parseComplete = false
    }
  if (!groups.size && text.trim() !== "No DNS configuration available") parseComplete = false
  const general = blocks.filter((value) => value.group === "general")
  const supplemental = general.filter((value) => value.domain !== undefined)
  const validServers =
    Array.isArray(servers) && servers.length <= 32 && servers.every((value) => typeof value === "string")
  const expected = validServers ? servers.map((value) => endpoint(value)) : []
  const actual = blocks.map((value) => value.servers.map((server) => endpoint(server, value.port)))
  const comparisonAvailable =
    parseComplete && validServers && expected.every(Boolean) && actual.every((values) => values.every(Boolean))
  const normalizedHostname =
    typeof hostname === "string" && /^[a-z0-9.-]{1,253}$/i.test(hostname)
      ? hostname.toLowerCase().replace(/\.$/, "")
      : undefined
  const selected = (values: Block[]) =>
    new Set(values.flatMap((value) => value.servers.map((server) => endpoint(server, value.port)!)))
  const expectedSet = new Set(expected.filter((value): value is string => value !== undefined))
  return {
    parseComplete,
    comparisonAvailable,
    resolverCount: parseComplete ? blocks.length : null,
    generalResolverCount: parseComplete ? general.length : null,
    supplementalResolverCount: parseComplete ? supplemental.length : null,
    scopedResolverCount: parseComplete ? blocks.filter((value) => value.group === "scoped").length : null,
    serviceSpecificResolverCount: parseComplete
      ? blocks.filter((value) => value.group === "service-specific").length
      : null,
    channelServerCount: validServers ? servers.length : null,
    firstGeneralServerSetEqual:
      comparisonAvailable && general.length > 0 ? same(selected([general[0]]), expectedSet) : null,
    domainlessGeneralServerSetEqual: comparisonAvailable
      ? same(selected(general.filter((value) => !value.domain)), expectedSet)
      : null,
    matchingSupplementalDomainPresent:
      parseComplete && normalizedHostname !== undefined
        ? supplemental.some(
            (value) => normalizedHostname === value.domain || normalizedHostname.endsWith(`.${value.domain}`),
          )
        : null,
    scopedPresent: parseComplete ? blocks.some((value) => value.group === "scoped") : null,
    serviceSpecificPresent: parseComplete ? blocks.some((value) => value.group === "service-specific") : null,
  }
}

// Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/js/node/child_process.ts#L599-L613
// Limit the cleanup-tail child and suppress stderr; synchronous return still depends on native wait.
export function observeCrossOSResolverRoute(
  hostname: string,
  readConfiguration: () => string = () =>
    execFileSync("/usr/sbin/scutil", ["--dns"], {
      timeout: 500,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }),
  createResolver: () => Pick<Resolver, "getServers"> = () => new Resolver({ timeout: 250, tries: 1 }),
) {
  const startedAtMs = performance.now()
  let servers: string[] = [],
    channelAvailable = false
  try {
    servers = createResolver().getServers()
    channelAvailable = true
  } catch {}
  const channelObservedAtMs = performance.now()
  try {
    const text = readConfiguration()
    return {
      purpose: "post-cleanup-passive-configuration-only" as const,
      channelContext: "fresh-default-channel-no-query-not-earlier-query-channel" as const,
      sampling: "sequential-configuration-snapshots-not-route-attestation" as const,
      startedAtMs,
      channelObservedAtMs,
      endedAtMs: performance.now(),
      channelAvailable,
      ...summarizeCrossOSResolverRoute(text, channelAvailable ? servers : undefined, hostname),
    }
  } catch (error) {
    let code: unknown
    try {
      const field = Object.getOwnPropertyDescriptor(error, "code")
      if (field && "value" in field) code = field.value
    } catch {}
    return {
      purpose: "post-cleanup-passive-configuration-only" as const,
      channelContext: "fresh-default-channel-no-query-not-earlier-query-channel" as const,
      sampling: "sequential-configuration-snapshots-not-route-attestation" as const,
      startedAtMs,
      channelObservedAtMs,
      endedAtMs: performance.now(),
      channelAvailable,
      parseComplete: false,
      comparisonAvailable: false,
      code: typeof code === "string" && ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES"].includes(code) ? code : "OTHER",
    }
  }
}
