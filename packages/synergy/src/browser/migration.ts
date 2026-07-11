import fs from "fs/promises"
import path from "path"
import { Global } from "../global/index.js"
import { MigrationRegistry } from "../migration/registry.js"
import type { Migration } from "../migration/types.js"
import { BrowserOwner } from "./owner.js"
import { BrowserStorage } from "./storage.js"
import {
  BrowserCheckpointSchema,
  BrowserProtocolErrorSchema,
  type BrowserCheckpoint,
  type BrowserProtocolErrorData,
} from "@ericsanchezok/synergy-browser"

export namespace BrowserMigration {
  export interface Result {
    ownerKey: string
    changed: boolean
    version: number
  }

  interface StoredState {
    version?: number
    status?: unknown
    page?: unknown
    tabs?: unknown
    activeTabID?: unknown
    panelWidth?: number
    timestamp?: number
    annotations?: unknown[]
    downloads?: unknown[]
    storageStatePath?: string
    profileDir?: string
    checkpoint?: unknown
    error?: unknown
    [key: string]: unknown
  }

  function legacyStateFilePath(owner: BrowserOwner.Info): string {
    const base = path.join(Global.Path.data, "browser", "sessions", legacyComponent(owner.scopeID, "scope"))
    if (owner.mode === "scope") return path.join(base, "scope.json")
    BrowserOwner.assertValid(owner)
    return path.join(base, "session", `${legacyComponent(owner.sessionID!, "session")}.json`)
  }

  async function exists(filepath: string): Promise<boolean> {
    try {
      await fs.access(filepath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async function readState(filepath: string): Promise<StoredState | null> {
    let text: string
    try {
      const info = await fs.lstat(filepath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) return null
      text = await Bun.file(filepath).text()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === "object" ? (parsed as StoredState) : null
    } catch {
      return null
    }
  }

  function isPage(value: unknown): value is { id: string; url: string; title: string; lastActiveAt?: number | null } {
    if (!value || typeof value !== "object") return false
    const page = value as Record<string, unknown>
    return (
      Boolean(page.id) && typeof page.id === "string" && typeof page.url === "string" && typeof page.title === "string"
    )
  }

  function pageFromState(state: StoredState) {
    const normalize = (page: { id: string; url: string; title: string; lastActiveAt?: number | null }) => ({
      id: normalizePageID(page.id),
      url: (page.url.startsWith("file:") ? "[local file]" : page.url).slice(0, 20_000),
      title: page.title.slice(0, 20_000),
      lastActiveAt: typeof page.lastActiveAt === "number" ? page.lastActiveAt : null,
    })
    if (isPage(state.page)) return normalize(state.page)
    if (!Array.isArray(state.tabs)) return null
    const tabs = state.tabs.filter(isPage)
    if (tabs.length === 0) return null
    if (typeof state.activeTabID === "string") {
      const active = tabs.find((page) => page.id === state.activeTabID)
      if (active) return normalize(active)
    }
    return tabs[0] ? normalize(tabs[0]) : null
  }

  function annotationsFromState(state: StoredState): BrowserStorage.StoredAnnotation[] {
    if (!Array.isArray(state.annotations)) return []
    return state.annotations.slice(0, 10_000).flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const annotation = { ...(value as Record<string, unknown>) }
      if (typeof annotation.pageURL !== "string" && typeof annotation.tabURL === "string") {
        annotation.pageURL = annotation.tabURL
      }
      if (
        typeof annotation.id !== "string" ||
        typeof annotation.pageURL !== "string" ||
        typeof annotation.pageID !== "string" ||
        typeof annotation.comment !== "string" ||
        !annotation.comment ||
        typeof annotation.resolved !== "boolean" ||
        typeof annotation.createdAt !== "number"
      ) {
        return []
      }
      return [
        {
          id: annotation.id.slice(0, 20_000),
          pageURL: annotation.pageURL.slice(0, 20_000),
          pageID: normalizePageID(annotation.pageID),
          ...(typeof annotation.ref === "string" ? { ref: annotation.ref.slice(0, 20_000) } : {}),
          ...(typeof annotation.element === "string" ? { element: annotation.element.slice(0, 100_000) } : {}),
          comment: annotation.comment.slice(0, 20_000),
          ...(annotation.styleFeedback && typeof annotation.styleFeedback === "object"
            ? { styleFeedback: stringRecord(annotation.styleFeedback) }
            : {}),
          resolved: annotation.resolved,
          createdAt: Math.max(0, Math.round(annotation.createdAt)),
        },
      ]
    })
  }

  function normalizePageID(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || `page-${crypto.randomUUID()}`
  }

  function checkpointFromState(
    state: StoredState,
    page: ReturnType<typeof pageFromState>,
  ): BrowserCheckpoint | undefined {
    if (!page || page.url.startsWith("[")) return undefined
    const value =
      state.checkpoint && typeof state.checkpoint === "object" ? (state.checkpoint as Record<string, unknown>) : {}
    const viewport =
      value.viewport && typeof value.viewport === "object" ? (value.viewport as Record<string, unknown>) : {}
    const scroll = value.scroll && typeof value.scroll === "object" ? (value.scroll as Record<string, unknown>) : {}
    const checkpoint = {
      url: typeof value.url === "string" ? value.url : page.url,
      cookies: Array.isArray(value.cookies)
        ? value.cookies.filter((cookie): cookie is Record<string, unknown> =>
            Boolean(cookie && typeof cookie === "object"),
          )
        : [],
      origins: Array.isArray(value.origins)
        ? value.origins.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return []
            const origin = entry as Record<string, unknown>
            if (typeof origin.origin !== "string") return []
            return [
              {
                origin: origin.origin,
                localStorage: stringRecord(origin.localStorage),
                sessionStorage: stringRecord(origin.sessionStorage),
              },
            ]
          })
        : [],
      viewport: {
        width: typeof viewport.width === "number" && viewport.width > 0 ? Math.round(viewport.width) : 1280,
        height: typeof viewport.height === "number" && viewport.height > 0 ? Math.round(viewport.height) : 720,
      },
      scroll: {
        x: typeof scroll.x === "number" ? scroll.x : 0,
        y: typeof scroll.y === "number" ? scroll.y : 0,
      },
      formState: [],
    }
    const parsed = BrowserCheckpointSchema.safeParse(checkpoint)
    return parsed.success ? parsed.data : undefined
  }

  function stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 10_000)
        .flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key.slice(0, 10_000), entry.slice(0, 1_000_000)]] : [],
        ),
    )
  }

  function migrateState(state: StoredState): BrowserStorage.SessionState {
    const page = pageFromState(state)
    const checkpoint = checkpointFromState(state, page)
    const error = migratedError(state.error)
    const next: BrowserStorage.SessionState = {
      version: BrowserStorage.CURRENT_VERSION,
      status: error ? "failed" : page ? "suspended" : "empty",
      page,
      panelWidth:
        typeof state.panelWidth === "number" ? Math.min(16_384, Math.max(1, Math.round(state.panelWidth))) : 400,
      timestamp: typeof state.timestamp === "number" && state.timestamp >= 0 ? Math.round(state.timestamp) : Date.now(),
      annotations: annotationsFromState(state),
      downloads: [],
      ...(checkpoint ? { checkpoint } : {}),
      ...(error ? { error } : {}),
    }
    return next
  }

  function migratedError(value: unknown): BrowserProtocolErrorData | undefined {
    const parsed = BrowserProtocolErrorSchema.safeParse(value)
    if (parsed.success) return parsed.data
    if (typeof value !== "string" || !value.trim()) return undefined
    return {
      type: "error",
      code: "browser_migrated_failure",
      message: value.slice(0, 100_000),
      retryable: true,
      suggestedAction: "Resume the Browser page to retry recovery.",
    }
  }

  async function migrateFile(owner: BrowserOwner.Info, filepath: string): Promise<Result> {
    const state = await readState(filepath)
    if (!state) return { ownerKey: BrowserOwner.key(owner), changed: false, version: BrowserStorage.CURRENT_VERSION }
    const next = migrateState(state)
    const changed = JSON.stringify(state) !== JSON.stringify(next)
    const target = BrowserStorage.pathForOwner(owner)
    if (changed || filepath !== target) await BrowserStorage.save(owner, next)
    if (filepath !== target) await fs.rm(filepath, { force: true })
    await removeRetiredProfilePath(state.storageStatePath)
    await removeRetiredProfilePath(state.profileDir)
    return { ownerKey: BrowserOwner.key(owner), changed, version: BrowserStorage.CURRENT_VERSION }
  }

  async function removeRetiredProfilePath(value: unknown): Promise<void> {
    if (typeof value !== "string" || !path.isAbsolute(value)) return
    const browserRoot = path.resolve(Global.Path.data, "browser")
    const target = path.resolve(value)
    if (target === browserRoot || !target.startsWith(`${browserRoot}${path.sep}`)) return
    let realTarget: string
    try {
      realTarget = await fs.realpath(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    const realBrowserRoot = await fs.realpath(browserRoot)
    if (realTarget === realBrowserRoot || !realTarget.startsWith(`${realBrowserRoot}${path.sep}`)) {
      throw new Error("Retired Browser profile path escaped Browser storage.")
    }
    const info = await fs.lstat(target)
    if (info.isSymbolicLink()) throw new Error("Retired Browser profile path must not be a symbolic link.")
    await fs.rm(realTarget, { recursive: true, force: true })
  }

  async function collectStateFiles(): Promise<{ owner: BrowserOwner.Info; filepath: string }[]> {
    const sessionsRoot = path.join(Global.Path.data, "browser", "sessions")
    const entries: { owner: BrowserOwner.Info; filepath: string }[] = []
    const scopes = await directoryEntries(sessionsRoot)
    for (const scopeID of scopes) {
      const scopeDir = path.join(sessionsRoot, scopeID)
      const scopeInfo = await fs.lstat(scopeDir)
      if (!scopeInfo.isDirectory() || scopeInfo.isSymbolicLink()) continue
      const scopeFile = path.join(scopeDir, "scope.json")
      if (await exists(scopeFile))
        entries.push({ owner: { mode: "scope", scopeID, directory: "" }, filepath: scopeFile })
      const sessionDir = path.join(scopeDir, "session")
      let files: string[] = []
      try {
        const sessionInfo = await fs.lstat(sessionDir)
        if (sessionInfo.isDirectory() && !sessionInfo.isSymbolicLink()) files = await directoryEntries(sessionDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      for (const filename of files) {
        if (!filename.endsWith(".json")) continue
        const filepath = path.join(sessionDir, filename)
        const fileInfo = await fs.lstat(filepath)
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 64 * 1024 * 1024) continue
        entries.push({
          owner: { mode: "session", scopeID, directory: "", sessionID: filename.slice(0, -5) },
          filepath,
        })
      }
    }
    return entries
  }

  export async function run(owner: BrowserOwner.Info): Promise<Result> {
    const current = BrowserStorage.pathForOwner(owner)
    if (await exists(current)) return migrateFile(owner, current)
    return migrateFile(owner, legacyStateFilePath(owner))
  }

  export async function runAll(progress?: (current: number, total: number) => void): Promise<void> {
    const files = await collectStateFiles()
    let current = 0
    for (const entry of files) {
      await migrateFile(entry.owner, entry.filepath)
      progress?.(++current, files.length)
    }
    await removeLegacySessionsRoot(path.join(Global.Path.data, "browser", "sessions"))
    if (files.length === 0) progress?.(0, 0)
  }
}

function legacyComponent(value: string, label: string): string {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Legacy Browser ${label} identifier is unsafe.`)
  }
  return value
}

async function directoryEntries(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function removeLegacySessionsRoot(sessionsRoot: string): Promise<void> {
  let info: Awaited<ReturnType<typeof fs.lstat>>
  try {
    info = await fs.lstat(sessionsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Legacy Browser sessions root is unsafe.")
  }
  const [realSessionsRoot, realBrowserRoot] = await Promise.all([
    fs.realpath(sessionsRoot),
    fs.realpath(path.join(Global.Path.data, "browser")),
  ])
  if (!realSessionsRoot.startsWith(`${realBrowserRoot}${path.sep}`)) {
    throw new Error("Legacy Browser sessions root escaped Browser storage.")
  }
  await fs.rm(realSessionsRoot, { recursive: true, force: true })
}

export const migrations: Migration[] = [
  {
    id: "20260710-browser-suspended-session-v4",
    description: "Persist browser pages as suspended descriptors without restoring them during state reads",
    domain: "browser",
    async up(progress) {
      await BrowserMigration.runAll(progress)
    },
  },
]

MigrationRegistry.register("browser", migrations)
