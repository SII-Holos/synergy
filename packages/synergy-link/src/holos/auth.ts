import os from "node:os"
import path from "node:path"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { applyEdits, modify, parse } from "jsonc-parser"
import z from "zod"
import type { SynergyLinkAuthState } from "../state/store"

export type SynergyLinkHolosAuthSource = "shared"

export const HOLOS_API_HOST = "api.holosai.io"
export const HOLOS_PORTAL_HOST = "www.holosai.io"
export const HOLOS_URL = `https://${HOLOS_API_HOST}`
export const HOLOS_WS_URL = `wss://${HOLOS_API_HOST}`
export const HOLOS_PORTAL_URL = `https://${HOLOS_PORTAL_HOST}`

export interface SynergyLinkHolosEndpoints {
  apiUrl: string
  wsUrl: string
  portalUrl: string
}

export const DEFAULT_HOLOS_ENDPOINTS: SynergyLinkHolosEndpoints = {
  apiUrl: HOLOS_URL,
  wsUrl: HOLOS_WS_URL,
  portalUrl: HOLOS_PORTAL_URL,
}

const HOLOS_CONFIG_FILENAME = "100-holos.jsonc"
const JSONC_FORMATTING = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const

const SynergyHolosAuth = z.object({
  type: z.literal("holos"),
  agentId: z.string(),
  agentSecret: z.string(),
})

const SynergyAuthRecord = z.record(z.string(), z.unknown())
const SynergyConfigSetMetadata = z.object({ active: z.string().min(1).default("default") })
const SynergyHolosEndpoints = z.object({
  apiUrl: z.string().optional(),
  wsUrl: z.string().optional(),
  portalUrl: z.string().optional(),
})
const SynergyConfig = z.object({ holos: SynergyHolosEndpoints.optional() })

export namespace SynergyLinkHolosAuth {
  export function synergyRoot() {
    return path.join(process.env.SYNERGY_TEST_HOME || os.homedir(), ".synergy")
  }

  export function sharedAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "api-key.json")
  }

  export function globalConfigPath() {
    return path.join(synergyRoot(), "config", "synergy.d", HOLOS_CONFIG_FILENAME)
  }

  export function configMetadataPath() {
    return path.join(synergyRoot(), "config", "config-set.json")
  }

  export async function legacyGlobalConfigPath() {
    try {
      const raw = await readFile(configMetadataPath(), "utf8")
      const metadata = SynergyConfigSetMetadata.parse(JSON.parse(raw))
      return metadata.active === "default"
        ? path.join(synergyRoot(), "config", "synergy.jsonc")
        : path.join(synergyRoot(), "config", "config-sets", metadata.active, "synergy.jsonc")
    } catch {
      return path.join(synergyRoot(), "config", "synergy.jsonc")
    }
  }

  export async function resolveEndpoints(): Promise<SynergyLinkHolosEndpoints> {
    const canonicalPath = globalConfigPath()
    const legacyPath = await legacyGlobalConfigPath()
    const config = await loadEndpointConfig(canonicalPath, legacyPath)
    const endpoints = {
      apiUrl: normalizeEndpoint(config.holos?.apiUrl, DEFAULT_HOLOS_ENDPOINTS.apiUrl, ["http:", "https:"]),
      wsUrl: normalizeEndpoint(config.holos?.wsUrl, DEFAULT_HOLOS_ENDPOINTS.wsUrl, ["ws:", "wss:"]),
      portalUrl: normalizeEndpoint(config.holos?.portalUrl, DEFAULT_HOLOS_ENDPOINTS.portalUrl, ["http:", "https:"]),
    }
    assertEndpointEnvironment(endpoints)
    return endpoints
  }

  export async function inspect(): Promise<
    { auth: SynergyLinkAuthState; source: SynergyLinkHolosAuthSource } | { auth: undefined; source: null }
  > {
    const shared = await loadShared()
    if (shared) {
      return {
        auth: shared,
        source: "shared",
      }
    }

    return {
      auth: undefined,
      source: null,
    }
  }

  export async function load(): Promise<SynergyLinkAuthState | undefined> {
    return (await inspect()).auth
  }

  export async function save(auth: SynergyLinkAuthState): Promise<void> {
    await saveShared(auth)
    await configureHolos()
  }

  export async function configureHolos(): Promise<void> {
    const filePath = globalConfigPath()
    const [source, endpoints] = await Promise.all([loadGlobalConfigSource(filePath), resolveEndpoints()])
    const next = applyEdits(
      source,
      modify(
        source,
        ["holos"],
        {
          enabled: true,
          ...endpoints,
        },
        { formattingOptions: JSONC_FORMATTING },
      ),
    )

    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`)
    await chmod(filePath, 0o600).catch(() => undefined)
  }

  export async function clear(): Promise<void> {
    await removeShared()
  }

  async function loadShared(): Promise<SynergyLinkAuthState | undefined> {
    try {
      const parsed = SynergyAuthRecord.parse(JSON.parse(await readFile(sharedAuthPath(), "utf8")))
      const holos = SynergyHolosAuth.safeParse(parsed.holos)
      if (!holos.success) return undefined
      return {
        agentID: holos.data.agentId,
        agentSecret: holos.data.agentSecret,
      }
    } catch {
      return undefined
    }
  }

  async function saveShared(auth: SynergyLinkAuthState): Promise<void> {
    const filePath = sharedAuthPath()
    let data: Record<string, unknown> = {}
    try {
      data = SynergyAuthRecord.parse(JSON.parse(await readFile(filePath, "utf8")))
    } catch {
      data = {}
    }

    const next = {
      ...data,
      holos: {
        type: "holos",
        agentId: auth.agentID,
        agentSecret: auth.agentSecret,
      },
    }

    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(next, null, 2) + "\n")
    await chmod(filePath, 0o600)
  }

  async function removeShared(): Promise<void> {
    let data: Record<string, unknown>
    try {
      data = SynergyAuthRecord.parse(JSON.parse(await readFile(sharedAuthPath(), "utf8")))
    } catch {
      await unlink(sharedAuthPath()).catch(() => undefined)
      return
    }

    delete data.holos
    await mkdir(path.dirname(sharedAuthPath()), { recursive: true })
    await writeFile(sharedAuthPath(), JSON.stringify(data, null, 2) + "\n")
  }

  async function loadGlobalConfigSource(filePath: string): Promise<string> {
    try {
      const source = await readFile(filePath, "utf8")
      return source.trim().length > 0 ? source : "{}\n"
    } catch {
      return "{}\n"
    }
  }
}

async function loadEndpointConfig(canonicalPath: string, legacyPath: string): Promise<z.infer<typeof SynergyConfig>> {
  try {
    return parseEndpointConfig(await readFile(canonicalPath, "utf8"))
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  try {
    return parseEndpointConfig(await readFile(legacyPath, "utf8"))
  } catch (error) {
    if (!isMissingFileError(error)) throw error
    return {}
  }
}

function parseEndpointConfig(source: string): z.infer<typeof SynergyConfig> {
  if (source.trim().length === 0) return {}
  const errors: import("jsonc-parser").ParseError[] = []
  const parsed = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new Error("Configured Holos endpoint file contains invalid JSONC.")
  }
  const config = SynergyConfig.safeParse(parsed)
  if (!config.success) {
    throw new Error("Configured Holos endpoint settings are invalid.")
  }
  return config.data
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function assertEndpointEnvironment(endpoints: SynergyLinkHolosEndpoints) {
  const api = new URL(endpoints.apiUrl)
  const websocket = new URL(endpoints.wsUrl)
  if (api.host !== websocket.host) {
    throw new Error("Holos API and WebSocket endpoints must use the same host and port.")
  }
}

function normalizeEndpoint(value: string | undefined, fallback: string, protocols: string[]): string {
  if (!value) return fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Configured Holos endpoint must be a valid URL.")
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`Configured Holos endpoint must use one of: ${protocols.join(", ")}`)
  }
  if (url.username || url.password) {
    throw new Error("Configured Holos endpoint must not contain credentials.")
  }
  return url.toString().replace(/\/$/, "")
}
