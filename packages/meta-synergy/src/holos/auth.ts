import os from "node:os"
import path from "node:path"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { applyEdits, modify } from "jsonc-parser"
import z from "zod"
import { MetaSynergyStore, type MetaSynergyAuthState } from "../state/store"

export type MetaSynergyHolosAuthSource = "shared" | "legacy-migrated"

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

const SynergyAuthRecord = z.record(z.string(), z.unknown())
const SynergyConfigSetMetadata = z.object({ active: z.string().min(1).default("default") })

export namespace MetaSynergyHolosAuth {
  export function synergyRoot() {
    return path.join(process.env.SYNERGY_TEST_HOME || os.homedir(), ".synergy")
  }

  export function sharedAuthPath() {
    return path.join(synergyRoot(), "data", "auth", "api-key.json")
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
    { auth: MetaSynergyAuthState; source: MetaSynergyHolosAuthSource } | { auth: undefined; source: null }
  > {
    const shared = await loadShared()
    if (shared) {
      return {
        auth: shared,
        source: "shared",
      }
    }

    const legacy = await loadLegacy()
    if (!legacy) {
      return {
        auth: undefined,
        source: null,
      }
    }

    await saveShared(legacy)
    return {
      auth: legacy,
      source: "legacy-migrated",
    }
  }

  export async function load(): Promise<MetaSynergyAuthState | undefined> {
    return (await inspect()).auth
  }

  export async function save(auth: MetaSynergyAuthState): Promise<void> {
    await saveShared(auth)
    await MetaSynergyStore.saveLegacyAuth(auth)
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
    await removeShared()
    await MetaSynergyStore.clearLegacyAuth()
  }

  async function loadShared(): Promise<MetaSynergyAuthState | undefined> {
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

  async function loadLegacy(): Promise<MetaSynergyAuthState | undefined> {
    return await MetaSynergyStore.loadLegacyAuth()
  }

  async function saveShared(auth: MetaSynergyAuthState): Promise<void> {
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
