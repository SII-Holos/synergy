import path from "path"
import fs from "fs/promises"
import { BrowserOwner } from "./owner.js"
import { BrowserMigration } from "./migration.js"
import { Global } from "../global/index.js"

export namespace BrowserStorage {
  export const CURRENT_VERSION = 3

  export interface StoredAnnotation {
    id: string
    pageURL: string
    pageID: string
    ref?: string
    element?: string
    comment: string
    styleFeedback?: Record<string, string>
    resolved: boolean
    createdAt: number
  }

  export interface SessionState {
    version?: number
    page: {
      id: string
      url: string
      title: string
      lastActiveAt?: number | null
    } | null
    panelWidth?: number
    timestamp: number
    annotations?: StoredAnnotation[]
    storageStatePath?: string
    profileDir?: string
  }

  function ownerSlug(owner: BrowserOwner.Info): string {
    const suffix = owner.mode === "scope" ? "scope" : `session-${owner.sessionID}`
    return `${owner.scopeID}-${suffix}`.replace(/[^a-zA-Z0-9._-]/g, "_")
  }

  function baseDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "sessions", owner.scopeID)
  }

  function stateFilePath(owner: BrowserOwner.Info): string {
    const base = baseDir(owner)
    if (owner.mode === "scope") return path.join(base, "scope.json")
    BrowserOwner.assertValid(owner)
    return path.join(base, "session", `${owner.sessionID}.json`)
  }

  export function profileDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "profiles", ownerSlug(owner))
  }

  export function storageStatePath(owner: BrowserOwner.Info): string {
    return path.join(profileDir(owner), "storage-state.json")
  }

  export function uploadsDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "uploads", ownerSlug(owner))
  }

  function sanitizeUrl(url: string): string {
    if (!url) return url
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "file:") return "[local file]"
      return parsed.toString()
    } catch {
      return url
    }
  }

  /** Read state. Returns null if no state file or on any read error. */
  export async function load(owner: BrowserOwner.Info): Promise<SessionState | null> {
    await BrowserMigration.run(owner)
    const fp = stateFilePath(owner)
    try {
      const file = Bun.file(fp)
      if (!(await file.exists())) return null
      return (await file.json()) as SessionState
    } catch {
      return null
    }
  }

  /** Persist session state. Creates parent dirs if needed. */
  export async function save(owner: BrowserOwner.Info, state: SessionState): Promise<void> {
    const sanitized: SessionState = {
      ...state,
      version: CURRENT_VERSION,
      storageStatePath: state.storageStatePath ?? storageStatePath(owner),
      profileDir: state.profileDir ?? profileDir(owner),
      page: state.page ? { ...state.page, url: sanitizeUrl(state.page.url) } : null,
    }
    const fp = stateFilePath(owner)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await Bun.write(fp, JSON.stringify(sanitized, null, 2))
  }

  /** Remove session state. */
  export async function remove(owner: BrowserOwner.Info): Promise<void> {
    const fp = stateFilePath(owner)
    try {
      await fs.unlink(fp)
    } catch {
      // file may not exist — nothing to remove
    }
  }

  /** Get storage path for an owner. */
  export function pathForOwner(owner: BrowserOwner.Info): string {
    return stateFilePath(owner)
  }

  export async function ensureOwnerDirs(owner: BrowserOwner.Info): Promise<void> {
    await fs.mkdir(path.dirname(stateFilePath(owner)), { recursive: true })
    await fs.mkdir(profileDir(owner), { recursive: true })
    await fs.mkdir(uploadsDir(owner), { recursive: true })
  }
}
