import { DEFAULT_SERVER_PORT } from "@ericsanchezok/synergy-harness/util/server-defaults"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { StorageMaintenance } from "@ericsanchezok/synergy-harness/storage/maintenance"
import { ensureMigrations } from "@ericsanchezok/synergy-harness/migration"
import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@ericsanchezok/synergy-harness/config/config"

export async function loadNetworkConfig() {
  if (Storage.available()) {
    await ensureMigrations({ output: "silent" })
  } else if ((await StorageBootstrap.status(Global.Path.root))?.phase !== "active") {
    await using maintenance = await StorageMaintenance.open()
  }
  Config.global.reset()
  return Config.global()
}

interface ResolveNetworkInput {
  argv?: string[]
  config?: Awaited<ReturnType<typeof Config.global>>
}

export function normalizeConnectHostname(hostname: string) {
  if (hostname === "0.0.0.0") return "127.0.0.1"
  if (hostname === "::") return "::1"
  return hostname
}

export async function resolveServerNetwork(input?: ResolveNetworkInput) {
  const network = await resolveNetworkArgv({
    ...input,
    defaults: { hostname: "127.0.0.1", port: DEFAULT_SERVER_PORT, mdns: false, cors: [] },
  })
  const connectHostname = normalizeConnectHostname(network.hostname)
  const url = new URL("http://127.0.0.1")
  url.hostname =
    connectHostname.includes(":") && !connectHostname.startsWith("[") ? `[${connectHostname}]` : connectHostname
  url.port = String(network.port)
  return { ...network, connectHostname, url: url.toString().replace(/\/$/, "") }
}

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "0.0.0.0",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

export async function isServerReachable(url: string): Promise<boolean> {
  const base = url.replace(/\/+$/, "")
  try {
    const response = await fetch(`${base}/global/health`, {
      headers: {
        accept: "application/json",
      },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return false
    const payload = await response.json().catch(() => undefined)
    return payload?.healthy === true && typeof payload?.version === "string"
  } catch {
    return false
  }
}

export async function resolveNetworkOptions(args: NetworkOptions) {
  Config.global.reset()
  return resolveNetworkArgv({
    argv: process.argv,
    config: await loadNetworkConfig(),
    defaults: {
      hostname: args.hostname,
      port: args.port,
      mdns: args.mdns,
      cors: Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : [],
    },
  })
}

export async function resolveNetworkArgv(
  input: ResolveNetworkInput & {
    defaults: {
      hostname: string
      port: number
      mdns: boolean
      cors: string[]
    }
  },
) {
  const argv = input.argv ?? process.argv
  if (!input.config) {
    Config.global.reset()
  }
  const config = input.config ?? (await loadNetworkConfig())
  const portExplicitlySet = argv.includes("--port")
  const hostnameExplicitlySet = argv.includes("--hostname")
  const mdnsExplicitlySet = argv.includes("--mdns")
  const corsExplicitlySet = argv.includes("--cors")

  const mdns = mdnsExplicitlySet
    ? readBooleanFlag(argv, "--mdns", input.defaults.mdns)
    : (config?.server?.mdns ?? input.defaults.mdns)
  const port = portExplicitlySet
    ? readNumberFlag(argv, "--port", input.defaults.port)
    : (config?.server?.port ?? input.defaults.port)
  const hostname = hostnameExplicitlySet
    ? readStringFlag(argv, "--hostname", input.defaults.hostname)
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? input.defaults.hostname)
  const argsCors = corsExplicitlySet ? readArrayFlag(argv, "--cors") : input.defaults.cors
  const cors = [...(config?.server?.cors ?? []), ...argsCors]

  return { hostname, port, mdns, cors }
}

function readFlagValues(argv: string[], name: string) {
  const values: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== name) continue
    const value = argv[index + 1]
    if (!value || value.startsWith("-")) continue
    values.push(value)
  }
  return values
}

function readStringFlag(argv: string[], name: string, fallback: string) {
  return readFlagValues(argv, name).at(-1) ?? fallback
}

function readNumberFlag(argv: string[], name: string, fallback: number) {
  const raw = readFlagValues(argv, name).at(-1)
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function readBooleanFlag(argv: string[], name: string, fallback: boolean) {
  if (!argv.includes(name)) return fallback
  const lastIndex = argv.lastIndexOf(name)
  const next = argv[lastIndex + 1]
  if (next === "true") return true
  if (next === "false") return false
  return true
}

function readArrayFlag(argv: string[], name: string) {
  return readFlagValues(argv, name)
}
