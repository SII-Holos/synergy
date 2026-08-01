import os from "node:os"
import path from "node:path"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { applyEdits, modify } from "jsonc-parser"
import z from "zod"
import type { SynergyLinkAuthState } from "../state/store"

export type SynergyLinkHolosAuthSource = "shared"

export const HOLOS_API_HOST = "api.holosai.io"
export const HOLOS_PORTAL_HOST = "www.holosai.io"
export const HOLOS_URL = `https://${HOLOS_API_HOST}`
export const HOLOS_WS_URL = `wss://${HOLOS_API_HOST}`
export const HOLOS_PORTAL_URL = `https://${HOLOS_PORTAL_HOST}`

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

export namespace SynergyLinkHolosAuth {
  export function synergyRoot() {
    return path.join(process.env.SYNERGY_TEST_HOME || os.homedir(), ".synergy")
  }

  export function sharedAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "api-key.json")
  }

  export function accountsAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "holos-accounts.json")
  }

  export function configMetadataPath() {
    return path.join(synergyRoot(), "config", "config-set.json")
  }

  export async function globalConfigPath() {
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
    const filePath = await globalConfigPath()
    const source = await loadGlobalConfigSource(filePath)
    const next = applyEdits(
      source,
      modify(
        source,
        ["holos"],
        {
          enabled: true,
          apiUrl: HOLOS_URL,
          wsUrl: HOLOS_WS_URL,
          portalUrl: HOLOS_PORTAL_URL,
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
    let parsed: SynergyHolosAccounts
    try {
      parsed = SynergyHolosAccounts.parse(JSON.parse(await readFile(accountsAuthPath(), "utf8")))
    } catch {
      return { authoritative: false }
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
  }

  async function removeActiveAccount(): Promise<void> {
    const stored = await readAccounts()
    if (!stored?.activeAccountId) return

    const accounts = { ...stored.accounts }
    delete accounts[stored.activeAccountId]
    await writePrivateJson(accountsAuthPath(), {
      activeAccountId: null,
      accounts,
    } satisfies SynergyHolosAccounts)
  }

  async function readAccounts(): Promise<SynergyHolosAccounts | undefined> {
    try {
      return SynergyHolosAccounts.parse(JSON.parse(await readFile(accountsAuthPath(), "utf8")))
    } catch {
      return undefined
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

  async function removeLegacy(): Promise<void> {
    let data: Record<string, unknown>
    try {
      data = SynergyAuthRecord.parse(JSON.parse(await readFile(sharedAuthPath(), "utf8")))
    } catch {
      return
    }

    if (!("holos" in data)) return
    delete data.holos
    await writePrivateJson(sharedAuthPath(), data)
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
