import { BrowserOwner } from "./owner.js"
import { Global } from "../global/index.js"
import { MigrationRegistry } from "../migration/registry.js"
import type { Migration } from "../migration/types.js"
import fs from "fs/promises"
import path from "path"

export namespace BrowserMigration {
  const CURRENT_VERSION = 2

  export interface Result {
    ownerKey: string
    changed: boolean
    version: number
  }

  interface StoredTab {
    id?: string
    url?: string
    title?: string
    order?: number
    pinned?: boolean
    kept?: boolean
    lastActiveAt?: number | null
  }

  interface StoredState {
    version?: number
    tabs?: StoredTab[]
    activeTabID?: string | null
    panelWidth?: number
    timestamp?: number
    annotations?: unknown[]
    storageStatePath?: string
    profileDir?: string
    [key: string]: unknown
  }

  function ownerSlug(owner: BrowserOwner.Info): string {
    const suffix = owner.mode === "scope" ? "scope" : `session-${owner.sessionID}`
    return `${owner.scopeID}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, "_")
  }

  function stateFilePath(owner: BrowserOwner.Info): string {
    const base = path.join(Global.Path.data, "browser", "sessions", owner.scopeID)
    if (owner.mode === "scope") return path.join(base, "scope.json")
    BrowserOwner.assertValid(owner)
    return path.join(base, "session", `${owner.sessionID}.json`)
  }

  function profileDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "profiles", ownerSlug(owner))
  }

  function storageStatePath(owner: BrowserOwner.Info): string {
    return path.join(profileDir(owner), "storage-state.json")
  }

  async function exists(filepath: string): Promise<boolean> {
    try {
      await fs.access(filepath)
      return true
    } catch {
      return false
    }
  }

  async function readState(filepath: string): Promise<StoredState | null> {
    try {
      const text = await Bun.file(filepath).text()
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== "object") return null
      return parsed as StoredState
    } catch {
      return null
    }
  }

  async function ensureStorageState(owner: BrowserOwner.Info): Promise<void> {
    const profile = profileDir(owner)
    const storage = storageStatePath(owner)
    await fs.mkdir(profile, { recursive: true })
    if (await exists(storage)) return
    await Bun.write(storage, JSON.stringify({ cookies: [], origins: [] }, null, 2))
  }

  async function migrateFile(owner: BrowserOwner.Info, filepath: string): Promise<Result> {
    const state = await readState(filepath)
    if (!state) {
      return {
        ownerKey: BrowserOwner.key(owner),
        changed: false,
        version: CURRENT_VERSION,
      }
    }

    await ensureStorageState(owner)

    const tabs = Array.isArray(state.tabs) ? state.tabs : []
    const activeTabExists = state.activeTabID ? tabs.some((tab) => tab.id === state.activeTabID) : false
    const nextActiveTabID = activeTabExists ? state.activeTabID! : (tabs[0]?.id ?? null)
    const nextProfileDir = profileDir(owner)
    const nextStorageStatePath = storageStatePath(owner)

    const next: StoredState = {
      ...state,
      version: CURRENT_VERSION,
      tabs,
      activeTabID: nextActiveTabID,
      timestamp: typeof state.timestamp === "number" ? state.timestamp : Date.now(),
      storageStatePath: nextStorageStatePath,
      profileDir: nextProfileDir,
    }

    const changed =
      state.version !== CURRENT_VERSION ||
      state.activeTabID !== next.activeTabID ||
      state.storageStatePath !== next.storageStatePath ||
      state.profileDir !== next.profileDir ||
      state.timestamp !== next.timestamp

    if (changed) {
      await fs.mkdir(path.dirname(filepath), { recursive: true })
      await Bun.write(filepath, JSON.stringify(next, null, 2))
    }

    return {
      ownerKey: BrowserOwner.key(owner),
      changed,
      version: CURRENT_VERSION,
    }
  }

  async function collectStateFiles(): Promise<{ owner: BrowserOwner.Info; filepath: string }[]> {
    const sessionsRoot = path.join(Global.Path.data, "browser", "sessions")
    const entries: { owner: BrowserOwner.Info; filepath: string }[] = []
    let scopes: string[] = []
    try {
      scopes = await fs.readdir(sessionsRoot)
    } catch {
      return entries
    }

    for (const scopeID of scopes) {
      const scopeDir = path.join(sessionsRoot, scopeID)
      const stat = await fs.stat(scopeDir).catch(() => null)
      if (!stat?.isDirectory()) continue

      const scopeFile = path.join(scopeDir, "scope.json")
      if (await exists(scopeFile)) {
        entries.push({
          owner: { mode: "scope", scopeID, directory: "" },
          filepath: scopeFile,
        })
      }

      const sessionDir = path.join(scopeDir, "session")
      let sessionFiles: string[] = []
      try {
        sessionFiles = await fs.readdir(sessionDir)
      } catch {
        continue
      }
      for (const filename of sessionFiles) {
        if (!filename.endsWith(".json")) continue
        const sessionID = filename.slice(0, -".json".length)
        entries.push({
          owner: { mode: "session", scopeID, directory: "", sessionID },
          filepath: path.join(sessionDir, filename),
        })
      }
    }

    return entries
  }

  export async function run(owner: BrowserOwner.Info): Promise<Result> {
    return migrateFile(owner, stateFilePath(owner))
  }

  export async function runAll(progress?: (current: number, total: number) => void): Promise<void> {
    const files = await collectStateFiles()
    let current = 0
    for (const entry of files) {
      await migrateFile(entry.owner, entry.filepath)
      current++
      progress?.(current, files.length)
    }
    if (files.length === 0) progress?.(0, 0)
  }
}

export const migrations: Migration[] = [
  {
    id: "20260624-browser-storage-v2",
    description: "Upgrade browser workspace state to isolated Playwright profile storage",
    domain: "browser",
    async up(progress) {
      await BrowserMigration.runAll(progress)
    },
  },
]

MigrationRegistry.register("browser", migrations)
