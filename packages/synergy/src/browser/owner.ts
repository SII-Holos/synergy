import type { Tool } from "../tool/tool"
import { ScopeContext } from "../scope/context"
import { browserOwnerKey } from "@ericsanchezok/synergy-browser"
import { createHash } from "node:crypto"

export namespace BrowserOwner {
  export type Mode = "session" | "scope"

  export interface Info {
    mode: Mode
    scopeID: string
    directory: string
    sessionID?: string // REQUIRED when mode === "session"
  }

  /** Unique string key for this owner. All runtime/storage/frontend use this key. */
  export function key(owner: Info): string {
    assertValid(owner)
    return browserOwnerKey(owner)
  }

  export function storageID(owner: Info): string {
    return createHash("sha256").update(key(owner)).digest("hex")
  }

  /** Throw if session-owned browser is missing sessionID. */
  export function assertValid(owner: Info): void {
    if ((owner.mode !== "session" && owner.mode !== "scope") || !owner.scopeID || owner.scopeID.length > 1_000) {
      throw new Error("Browser owner scope is invalid")
    }
    if (owner.mode === "session" && !owner.sessionID) {
      throw new Error("Session-owned browser requires a sessionID")
    }
    if (owner.sessionID && owner.sessionID.length > 1_000) throw new Error("Browser owner session is invalid")
    if (owner.mode === "scope" && owner.sessionID !== undefined) {
      throw new Error("Scope-owned browser does not accept a sessionID")
    }
  }

  /** Derive owner from tool execution context. Defaults to session mode. */
  export function fromToolContext(ctx: Tool.Context): Info {
    return {
      mode: "session",
      scopeID: ScopeContext.current.scope.id,
      directory: ScopeContext.current.directory,
      sessionID: ctx.sessionID,
    }
  }

  /** Derive owner from WebSocket route parameters. */
  export function fromRoute(input: { directory: string; scopeID: string; sessionID?: string; mode?: Mode }): Info {
    return {
      mode: input.mode ?? "session",
      scopeID: input.scopeID,
      directory: input.directory,
      sessionID: input.sessionID,
    }
  }
}
