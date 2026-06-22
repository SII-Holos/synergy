import path from "path"
import os from "os"
import fs from "fs/promises"
import { BrowserOwner } from "./owner.js"

export namespace BrowserStorage {
  export interface StoredAnnotation {
    id: string
    tabURL: string
    tabID: string
    ref?: string
    element?: string
    comment: string
    styleFeedback?: Record<string, string>
    resolved: boolean
    createdAt: number
  }

  export interface SessionState {
    tabs: { id: string; url: string; title: string; order: number }[]
    activeTabID: string | null
    panelWidth?: number
    timestamp: number
    annotations?: StoredAnnotation[]
  }

  function stateFilePath(owner: BrowserOwner.Info): string {
    const base = path.join(os.homedir(), ".synergy", "data", "browser", "sessions", owner.scopeID)
    if (owner.mode === "scope") return path.join(base, "scope.json")
    BrowserOwner.assertValid(owner)
    return path.join(base, "session", `${owner.sessionID}.json`)
  }

  function sanitizeUrl(url: string): string {
    if (!url) return url
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "file:") return "[local file]"
      parsed.search = ""
      parsed.hash = ""
      return parsed.toString()
    } catch {
      return url
    }
  }

  /** Read state. Returns null if no state file or on any read error. */
  export async function load(owner: BrowserOwner.Info): Promise<SessionState | null> {
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
      tabs: state.tabs.map((tab) => ({
        ...tab,
        url: sanitizeUrl(tab.url),
      })),
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
}
