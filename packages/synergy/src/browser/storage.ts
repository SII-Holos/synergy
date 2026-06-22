import path from "path"
import fs from "fs/promises"
import { Global } from "../global"

export namespace BrowserStorage {
  export interface SessionState {
    scopeID: string
    sessionID?: string
    tabs: { id: string; url: string; title: string; order: number }[]
    activeTabID: string | null
    panelWidth: number
    timestamp: number
  }

  function sessionsDir(scopeID: string): string {
    return path.join(Global.Path.data, "browser", "sessions", scopeID)
  }

  function filePath(scopeID: string, sessionID?: string): string {
    return path.join(sessionsDir(scopeID), `${sessionID ?? "current"}.json`)
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
  export async function load(key: { scopeID: string; sessionID?: string }): Promise<SessionState | null> {
    const fp = filePath(key.scopeID, key.sessionID)
    try {
      const file = Bun.file(fp)
      if (!(await file.exists())) return null
      return (await file.json()) as SessionState
    } catch {
      return null
    }
  }

  /** Persist session state. Creates parent dirs if needed. */
  export async function save(state: SessionState): Promise<void> {
    const sanitized: SessionState = {
      ...state,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        url: sanitizeUrl(tab.url),
      })),
    }
    const dir = sessionsDir(state.scopeID)
    await fs.mkdir(dir, { recursive: true })
    const fp = path.join(dir, `${state.sessionID ?? "current"}.json`)
    await Bun.write(fp, JSON.stringify(sanitized, null, 2))
  }

  /** Remove session state. */
  export async function remove(key: { scopeID: string; sessionID?: string }): Promise<void> {
    const fp = filePath(key.scopeID, key.sessionID)
    try {
      await fs.unlink(fp)
    } catch {
      // file may not exist — nothing to remove
    }
  }

  /** Get storage path for a scope's sessions directory. */
  export function pathForScope(scopeID: string): string {
    return sessionsDir(scopeID)
  }
}
