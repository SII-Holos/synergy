import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config/config"

interface ResolveNetworkInput {
  argv?: string[]
  config?: Awaited<ReturnType<typeof Config.global>>
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
  return resolveNetworkArgv({
    argv: process.argv,
    config: await Config.global(),
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
  const config = input.config ?? (await Config.global())
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
