import type { Tool } from "../tool/tool"
import { ScopeContext } from "../scope/context"

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
    if (owner.mode === "session") {
      return `${owner.scopeID}:session:${owner.sessionID}`
    }
    return `${owner.scopeID}:scope`
  }

  /** Throw if session-owned browser is missing sessionID. */
  export function assertValid(owner: Info): void {
    if (owner.mode === "session" && !owner.sessionID) {
      throw new Error("Session-owned browser requires a sessionID")
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
