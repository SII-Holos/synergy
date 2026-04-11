import os from "node:os"
import path from "node:path"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import z from "zod"
import { MetaSynergyStore, type MetaSynergyAuthState } from "../state/store"

export type MetaSynergyHolosAuthSource = "shared" | "legacy-migrated"

const SynergyHolosAuth = z.object({
  type: z.literal("holos"),
  agentId: z.string(),
  agentSecret: z.string(),
})

const SynergyAuthRecord = z.record(z.string(), z.unknown())

export namespace MetaSynergyHolosAuth {
  export function sharedAuthPath() {
    return path.join(process.env.SYNERGY_TEST_HOME || os.homedir(), ".synergy", "data", "auth", "api-key.json")
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
    let data: Record<string, unknown> = {}
    try {
      data = SynergyAuthRecord.parse(JSON.parse(await readFile(sharedAuthPath(), "utf8")))
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

    await mkdir(path.dirname(sharedAuthPath()), { recursive: true })
    await writeFile(sharedAuthPath(), JSON.stringify(next, null, 2) + "\n")
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
}
