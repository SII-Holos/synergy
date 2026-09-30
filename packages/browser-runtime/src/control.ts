import {
  BrowserUserCommandSchema,
  normalizeBrowserURL,
  type BrowserBackendResult,
  type BrowserPage,
  type BrowserSessionPage,
  type BrowserUserCommand,
} from "@ericsanchezok/synergy-browser-core"
import type { BrowserSession } from "./types.js"
import type { BrowserPageBackend } from "./page.js"

export namespace BrowserControl {
  export type Command = BrowserUserCommand
  export type Result = BrowserBackendResult

  export interface SessionState {
    status: BrowserSession["status"]
    pages: BrowserSessionPage[]
  }

  export function parseCommand(input: unknown): Command {
    return BrowserUserCommandSchema.parse(input)
  }

  export function normalizeCommand(command: Command): Command {
    return command.type === "navigate" ? { ...command, url: normalizeBrowserURL(command.url) } : command
  }

  export function pageState(page: BrowserPageBackend): BrowserPage {
    return {
      id: page.id,
      url: page.url,
      title: page.title,
      isLoading: page.loading,
      lastActiveAt: page.lastActiveAt,
    }
  }

  export function sessionState(session: BrowserSession): SessionState {
    return { status: session.status, pages: session.pages }
  }
}
