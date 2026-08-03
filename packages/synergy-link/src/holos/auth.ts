import {
  authLockDirectory,
  HOLOS_ACCOUNTS_WRITE_LOCK_KEY,
  LEGACY_API_KEY_WRITE_LOCK_KEY,
  withFileLock,
} from "@ericsanchezok/synergy-util/fs-lock"
import os from "node:os"
import path from "node:path"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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

export function holosEndpointURL(route: string, baseURL: string): string {
  return new URL(route.replace(/^\//, ""), baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString()
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

const SynergyHolosAccount = z.object({
  agentId: z.string(),
  agentSecret: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const SynergyHolosAccounts = z.object({
  activeAccountId: z.string().nullable(),
  accounts: z.record(z.string(), SynergyHolosAccount),
})

type SynergyHolosAccounts = z.infer<typeof SynergyHolosAccounts>

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
    return path.join(process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir(), ".synergy")
  }

  export function sharedAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "api-key.json")
  }

  export function accountsAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "holos-accounts.json")
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
    const accounts = await loadAccounts()
    if (accounts.authoritative) {
      if (!accounts.auth) {
        return {
          auth: undefined,
          source: null,
        }
      }
      return {
        auth: accounts.auth,
        source: "shared",
      }
    }

    const legacy = await loadLegacy()
    if (legacy) {
      return {
        auth: legacy,
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
    await saveAccount(auth)
    await removeLegacy()
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
    await Promise.all([removeActiveAccount(), removeLegacy()])
  }

  async function loadAccounts(): Promise<
    { authoritative: true; auth: SynergyLinkAuthState | undefined } | { authoritative: false }
  > {
    let raw: string
    try {
      raw = await readFile(accountsAuthPath(), "utf8")
    } catch (error) {
      if (isEnoent(error)) return { authoritative: false }
      throw error
    }

    let parsed: SynergyHolosAccounts
    try {
      parsed = SynergyHolosAccounts.parse(JSON.parse(raw))
    } catch (error) {
      throw new Error("Failed to parse the shared Holos account store.", { cause: error })
    }

    const active = parsed.activeAccountId ? parsed.accounts[parsed.activeAccountId] : undefined
    return {
      authoritative: true,
      auth: active
        ? {
            agentID: active.agentId,
            agentSecret: active.agentSecret,
          }
        : undefined,
    }
  }

  async function loadLegacy(): Promise<SynergyLinkAuthState | undefined> {
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

  async function saveAccount(auth: SynergyLinkAuthState): Promise<void> {
    await withAccountsWriteLock(async () => {
      const filePath = accountsAuthPath()
      const stored = await readAccountsForUpdate()
      const now = Date.now()
      const existing = stored.accounts[auth.agentID]

      const next = {
        activeAccountId: auth.agentID,
        accounts: {
          ...stored.accounts,
          [auth.agentID]: {
            agentId: auth.agentID,
            agentSecret: auth.agentSecret,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          },
        },
      } satisfies SynergyHolosAccounts

      await writePrivateJson(filePath, next)
    })
  }

  async function removeActiveAccount(): Promise<void> {
    await withAccountsWriteLock(async () => {
      const stored = await readAccounts()
      if (!stored?.activeAccountId) return

      const accounts = { ...stored.accounts }
      delete accounts[stored.activeAccountId]
      await writePrivateJson(accountsAuthPath(), {
        activeAccountId: null,
        accounts,
      } satisfies SynergyHolosAccounts)
    })
  }

  async function readAccounts(): Promise<SynergyHolosAccounts | undefined> {
    let raw: string
    try {
      raw = await readFile(accountsAuthPath(), "utf8")
    } catch (error) {
      if (isEnoent(error)) return undefined
      throw error
    }

    try {
      return SynergyHolosAccounts.parse(JSON.parse(raw))
    } catch (error) {
      throw new Error("Failed to parse the shared Holos account store.", { cause: error })
    }
  }

  async function readAccountsForUpdate(): Promise<SynergyHolosAccounts> {
    let raw: string
    try {
      raw = await readFile(accountsAuthPath(), "utf8")
    } catch (error) {
      if (isEnoent(error)) {
        return {
          activeAccountId: null,
          accounts: {},
        }
      }
      throw error
    }

    try {
      return SynergyHolosAccounts.parse(JSON.parse(raw))
    } catch (error) {
      throw new Error("Failed to parse the shared Holos account store.", { cause: error })
    }
  }

  async function withAccountsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return await withFileLock(
      {
        directory: authLockDirectory(synergyRoot()),
        key: HOLOS_ACCOUNTS_WRITE_LOCK_KEY,
        timeoutMessage: "Timed out acquiring Holos accounts lock",
      },
      fn,
    )
  }

  async function removeLegacy(): Promise<void> {
    await withFileLock(
      {
        directory: authLockDirectory(synergyRoot()),
        key: LEGACY_API_KEY_WRITE_LOCK_KEY,
        timeoutMessage: "Timed out acquiring legacy credential lock",
      },
      async () => {
        let data: Record<string, unknown>
        try {
          data = SynergyAuthRecord.parse(JSON.parse(await readFile(sharedAuthPath(), "utf8")))
        } catch {
          return
        }

        if (!("holos" in data)) return
        delete data.holos
        await writePrivateJson(sharedAuthPath(), data)
      },
    )
  }

  async function writePrivateJson(filePath: string, data: unknown): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await mkdir(path.dirname(filePath), { recursive: true })
    try {
      await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      await rename(temporaryPath, filePath)
      await chmod(filePath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
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

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
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
