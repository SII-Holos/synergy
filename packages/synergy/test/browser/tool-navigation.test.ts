import { afterEach, describe, expect, test } from "bun:test"
import {
  BrowserProtocolError,
  type BrowserBackendCommand,
  type BrowserBackendResult,
} from "@ericsanchezok/synergy-browser"
import { BrowserCommandService } from "../../src/browser/command-service"
import type { BrowserOwner } from "../../src/browser/owner"
import type { BrowserPageBackend } from "../../src/browser/page"
import type { BrowserSession } from "../../src/browser/types"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope",
  sessionID: "session",
  directory: "/tmp/synergy-browser-test",
}

function fakePage(executions: string[], delayMs = 0): BrowserPageBackend {
  const page = {
    id: "page-1",
    backend: "headless" as const,
    url: "about:blank",
    title: "",
    loading: false,
    lastActiveAt: null,
    async execute(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
      executions.push(`start:${command.type}`)
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      executions.push(`end:${command.type}`)
      if (command.type === "navigate") {
        page.url = command.url
        page.title = "Example"
        return { type: "navigation", page: pageState(page) }
      }
      if (command.type === "action") return { type: "action", pageId: page.id, action: command.action.type }
      return { type: "void" }
    },
    async close() {},
    isAlive() {
      return true
    },
  } satisfies BrowserPageBackend
  return page
}

function fakeSession(initialPage: BrowserPageBackend | null): BrowserSession {
  let current = initialPage
  return {
    owner,
    get page() {
      return current
    },
    get status() {
      return current ? "active" : "empty"
    },
    get descriptor() {
      return current
        ? { id: current.id, url: current.url, title: current.title, lastActiveAt: current.lastActiveAt }
        : null
    },
    annotations: [],
    checkpoint: null,
    error: null,
    async ensurePage() {
      current ??= fakePage([])
      return current
    },
    async resumePage() {
      current ??= fakePage([])
      return current
    },
    async closePage() {
      current = null
    },
    getPage(id) {
      return current?.id === id ? current : undefined
    },
    async addAnnotation() {
      throw new Error("not implemented")
    },
    async removeAnnotation() {
      return false
    },
    async clearAnnotations() {},
    formatAnnotationsForContext() {
      return ""
    },
    async notifyPageNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async dispose() {},
  }
}

let restoreRuntime: (() => void) | undefined
afterEach(() => {
  restoreRuntime?.()
  restoreRuntime = undefined
  BrowserCommandService.clear()
})

describe("BrowserCommandService", () => {
  test("replays a commandId without repeating its side effect", async () => {
    const executions: string[] = []
    const session = fakeSession(fakePage(executions))
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    const request = {
      commandId: "same",
      command: { type: "action", action: { type: "click", target: { kind: "point", x: 1, y: 2 } } } as const,
    }
    const first = await BrowserCommandService.execute(owner, request)
    const second = await BrowserCommandService.execute(owner, request)
    expect(second).toEqual(first)
    expect(executions).toEqual(["start:action", "end:action"])
  })

  test("serializes managed download cancellation with page commands", async () => {
    const executions: string[] = []
    const session = fakeSession(fakePage(executions))
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    await BrowserCommandService.execute(owner, {
      commandId: "cancel-download",
      command: { type: "download.cancel", id: "download-1" },
    })
    expect(executions).toEqual(["start:download.cancel", "end:download.cancel"])
  })

  test("binds commandId to one payload and replays failures without repeating work", async () => {
    let executions = 0
    const page = fakePage([])
    page.execute = async () => {
      executions++
      throw new BrowserProtocolError({
        code: "browser_fixture_failed",
        message: "fixture failed",
        retryable: true,
      })
    }
    const session = fakeSession(page)
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    const request = { commandId: "failed", command: { type: "reload" } as const }
    await expect(BrowserCommandService.execute(owner, request)).rejects.toMatchObject({
      code: "browser_fixture_failed",
    })
    await expect(BrowserCommandService.execute(owner, request)).rejects.toMatchObject({
      code: "browser_fixture_failed",
    })
    expect(executions).toBe(1)
    await expect(
      BrowserCommandService.execute(owner, { commandId: "failed", command: { type: "stop" } }),
    ).rejects.toMatchObject({ code: "browser_command_id_conflict" })
  })

  test("serializes concurrent commands for one owner", async () => {
    const executions: string[] = []
    const session = fakeSession(fakePage(executions, 10))
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    await Promise.all([
      BrowserCommandService.execute(owner, { commandId: "a", command: { type: "reload" } }),
      BrowserCommandService.execute(owner, { commandId: "b", command: { type: "stop" } }),
    ])
    expect(executions).toEqual(["start:reload", "end:reload", "start:stop", "end:stop"])
  })

  test("drains the owner queue before disposal and rejects late commands", async () => {
    const executions: string[] = []
    const session = fakeSession(fakePage(executions, 20))
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    const active = BrowserCommandService.execute(owner, {
      commandId: "active-before-dispose",
      command: { type: "reload" },
    })
    await Promise.resolve()
    const disposal = BrowserCommandService.disposeOwner(owner, async () => {
      executions.push("dispose")
    })
    await expect(
      BrowserCommandService.execute(owner, { commandId: "late-command", command: { type: "reload" } }),
    ).rejects.toMatchObject({ code: "browser_session_closing" })
    await Promise.all([active, disposal])
    expect(executions).toEqual(["start:reload", "end:reload", "dispose"])
  })

  test("user navigation lazily creates one page and normalizes the URL", async () => {
    const executions: string[] = []
    let creates = 0
    const session = fakeSession(null)
    const originalEnsure = session.ensurePage
    session.ensurePage = async (...args) => {
      creates++
      const page = await originalEnsure(...args)
      page.execute = fakePage(executions).execute
      return page
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    const result = await BrowserCommandService.execute(owner, {
      commandId: "navigate",
      command: { type: "navigate", source: "user", url: "example.com" },
    })
    expect(result).toMatchObject({ type: "navigation", page: { url: "https://example.com" } })
    expect(creates).toBe(1)
  })

  test("rejects commands without a page using a stable structured error", async () => {
    const session = fakeSession(null)
    restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return session
      },
    })
    await expect(
      BrowserCommandService.execute(owner, { commandId: "read", command: { type: "snapshot", maxNodes: 10 } }),
    ).rejects.toMatchObject({
      code: "browser_page_missing",
      retryable: false,
    } satisfies Partial<BrowserProtocolError>)
  })
})

function pageState(page: BrowserPageBackend) {
  return { id: page.id, url: page.url, title: page.title, isLoading: page.loading, lastActiveAt: page.lastActiveAt }
}
