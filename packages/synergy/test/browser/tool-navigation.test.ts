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

function fakeSession(initialPage: BrowserPageBackend | null): BrowserSession & { suspend(): Promise<void> } {
  let current = initialPage
  let descriptor = current
    ? { id: current.id, url: current.url, title: current.title, lastActiveAt: current.lastActiveAt }
    : null
  let status: BrowserSession["status"] = current ? "active" : "empty"
  return {
    owner,
    get page() {
      return current
    },
    get status() {
      return current ? "active" : status
    },
    get descriptor() {
      return current
        ? { id: current.id, url: current.url, title: current.title, lastActiveAt: current.lastActiveAt }
        : descriptor
    },
    annotations: [],
    checkpoint: null,
    error: null,
    async ensurePage() {
      current ??= fakePage([])
      status = "active"
      return current
    },
    async resumePage() {
      current ??= fakePage([])
      status = "active"
      return current
    },
    async closePage() {
      current = null
      descriptor = null
      status = "empty"
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
    async suspend() {
      if (current) {
        descriptor = { id: current.id, url: current.url, title: current.title, lastActiveAt: current.lastActiveAt }
      }
      current = null
      status = descriptor ? "suspended" : "empty"
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
  test("suspends a headless session owner after browser command activity becomes idle", async () => {
    const session = fakeSession(fakePage([]))
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 20 },
    )

    await BrowserCommandService.execute(owner, { commandId: "idle-reload", command: { type: "reload" } })
    await Bun.sleep(50)

    expect(suspensions).toBe(1)
  })

  test("refreshes the owner idle deadline after each browser command", async () => {
    const session = fakeSession(fakePage([]))
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 40 },
    )

    await BrowserCommandService.execute(owner, { commandId: "first-activity", command: { type: "reload" } })
    await Bun.sleep(25)
    await BrowserCommandService.execute(owner, { commandId: "second-activity", command: { type: "stop" } })
    await Bun.sleep(25)
    expect(suspensions).toBe(0)

    await Bun.sleep(30)
    expect(suspensions).toBe(1)
  })

  test("does not schedule idle suspension after an explicit close", async () => {
    const session = fakeSession(fakePage([]))
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 20 },
    )

    await BrowserCommandService.execute(owner, { commandId: "close-page", command: { type: "close" } })
    await Bun.sleep(50)

    expect(session.status).toBe("empty")
    expect(suspensions).toBe(0)
  })

  test("does not suspend host pages or scope owners from command inactivity", async () => {
    const cases: Array<{ testOwner: BrowserOwner.Info; backend: BrowserPageBackend["backend"] }> = [
      { testOwner: owner, backend: "host" },
      { testOwner: { ...owner, mode: "scope", sessionID: undefined }, backend: "headless" },
    ]
    for (const { testOwner, backend } of cases) {
      const page = fakePage([])
      Object.defineProperty(page, "backend", { value: backend })
      const session = fakeSession(page)
      let suspensions = 0
      session.suspend = async () => {
        suspensions++
      }
      restoreRuntime = BrowserCommandService.useRuntimeForTest(
        {
          async getOrCreateSession() {
            return session
          },
        },
        { ownerIdleMs: 10 },
      )
      await BrowserCommandService.execute(testOwner, { commandId: `idle-${backend}`, command: { type: "stop" } })
      await Bun.sleep(30)
      expect(suspensions).toBe(0)
      restoreRuntime()
      restoreRuntime = undefined
    }
  })

  test("starts a fresh idle window when a command crosses the prior deadline", async () => {
    const session = fakeSession(fakePage([], 30))
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 40 },
    )

    await BrowserCommandService.execute(owner, { commandId: "before-deadline", command: { type: "reload" } })
    await Bun.sleep(25)
    await BrowserCommandService.execute(owner, { commandId: "crosses-deadline", command: { type: "stop" } })
    await Bun.sleep(15)
    expect(suspensions).toBe(0)
    await Bun.sleep(35)
    expect(suspensions).toBe(1)
  })

  test("rearms idle suspension after an explicit close fails", async () => {
    const session = fakeSession(fakePage([]))
    session.closePage = async () => {
      throw new BrowserProtocolError({
        code: "browser_page_close_failed",
        message: "close failed",
        retryable: true,
      })
    }
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 20 },
    )

    await expect(
      BrowserCommandService.execute(owner, { commandId: "failed-close", command: { type: "close" } }),
    ).rejects.toMatchObject({ code: "browser_page_close_failed" })
    await Bun.sleep(50)
    expect(suspensions).toBe(1)
  })

  test("does not let an earlier successful close clear a newer command deadline", async () => {
    const session = fakeSession(fakePage([]))
    const closeStarted = Promise.withResolvers<void>()
    const releaseClose = Promise.withResolvers<void>()
    const closePage = session.closePage.bind(session)
    session.closePage = async () => {
      closeStarted.resolve()
      await releaseClose.promise
      await closePage()
    }
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    const close = BrowserCommandService.execute(owner, { commandId: "stale-close", command: { type: "close" } })
    await closeStarted.promise
    const navigate = BrowserCommandService.execute(owner, {
      commandId: "after-close",
      command: { type: "navigate", source: "user", url: "https://example.com" },
    })
    releaseClose.resolve()
    await Promise.all([close, navigate])
    await Bun.sleep(30)

    expect(suspensions).toBe(1)
  })

  test("cancels idle suspension for activity accepted before suspension starts", async () => {
    const session = fakeSession(fakePage([]))
    const suspensionLookupStarted = Promise.withResolvers<void>()
    const releaseSuspensionLookup = Promise.withResolvers<void>()
    let lookups = 0
    let suspensions = 0
    session.suspend = async () => {
      suspensions++
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          lookups++
          if (lookups === 2) {
            suspensionLookupStarted.resolve()
            await releaseSuspensionLookup.promise
          }
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "arm-pre-suspend", command: { type: "stop" } })
    await suspensionLookupStarted.promise
    const reload = BrowserCommandService.execute(owner, {
      commandId: "before-suspend-start",
      command: { type: "reload" },
    })
    releaseSuspensionLookup.resolve()

    await expect(reload).resolves.toMatchObject({ type: "void" })
    expect(suspensions).toBe(0)
    expect(session.page).not.toBeNull()
  })

  test("restores the page for a command accepted during idle suspension", async () => {
    const session = fakeSession(fakePage([]))
    const suspendStarted = Promise.withResolvers<void>()
    const releaseSuspend = Promise.withResolvers<void>()
    const suspend = session.suspend.bind(session)
    session.suspend = async () => {
      suspendStarted.resolve()
      await releaseSuspend.promise
      await suspend()
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "arm-idle", command: { type: "stop" } })
    await suspendStarted.promise
    const reload = BrowserCommandService.execute(owner, {
      commandId: "during-suspend",
      command: { type: "reload" },
    })
    releaseSuspend.resolve()

    await expect(reload).resolves.toMatchObject({ type: "void" })
    expect(session.page).not.toBeNull()
  })

  test("restores the page after stale idle suspension cleanup fails", async () => {
    const session = fakeSession(fakePage([]))
    const suspendStarted = Promise.withResolvers<void>()
    const releaseSuspend = Promise.withResolvers<void>()
    const suspend = session.suspend.bind(session)
    session.suspend = async () => {
      suspendStarted.resolve()
      await releaseSuspend.promise
      await suspend()
      throw new Error("idle cleanup failed")
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "arm-failed-idle", command: { type: "stop" } })
    await suspendStarted.promise
    const reload = BrowserCommandService.execute(owner, {
      commandId: "during-failed-suspend",
      command: { type: "reload" },
    })
    releaseSuspend.resolve()

    await expect(reload).resolves.toMatchObject({ type: "void" })
    expect(session.page).not.toBeNull()
  })

  test("does not reopen the page for a replay during idle suspension", async () => {
    const session = fakeSession(fakePage([]))
    const suspendStarted = Promise.withResolvers<void>()
    const releaseSuspend = Promise.withResolvers<void>()
    const suspendFinished = Promise.withResolvers<void>()
    const suspend = session.suspend.bind(session)
    session.suspend = async () => {
      suspendStarted.resolve()
      await releaseSuspend.promise
      await suspend()
      suspendFinished.resolve()
    }
    let resumes = 0
    const resumePage = session.resumePage.bind(session)
    session.resumePage = async () => {
      resumes++
      return resumePage()
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )
    const request = { commandId: "replay-during-suspend", command: { type: "stop" } as const }

    await BrowserCommandService.execute(owner, request)
    await suspendStarted.promise
    await expect(BrowserCommandService.execute(owner, request)).resolves.toMatchObject({ type: "void" })
    releaseSuspend.resolve()
    await suspendFinished.promise
    await Bun.sleep(0)

    expect(resumes).toBe(0)
    expect(session.page).toBeNull()
  })

  test("does not reopen the page for close accepted during idle suspension", async () => {
    const session = fakeSession(fakePage([]))
    const suspendStarted = Promise.withResolvers<void>()
    const releaseSuspend = Promise.withResolvers<void>()
    const suspend = session.suspend.bind(session)
    session.suspend = async () => {
      suspendStarted.resolve()
      await releaseSuspend.promise
      await suspend()
    }
    let resumes = 0
    const resumePage = session.resumePage.bind(session)
    session.resumePage = async () => {
      resumes++
      return resumePage()
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "arm-close-race", command: { type: "stop" } })
    await suspendStarted.promise
    const close = BrowserCommandService.execute(owner, {
      commandId: "close-during-suspend",
      command: { type: "close" },
    })
    releaseSuspend.resolve()

    await expect(close).resolves.toMatchObject({ type: "void" })
    expect(resumes).toBe(0)
    expect(session.page).toBeNull()
  })

  test("does not revive a page closed ahead of a queued command", async () => {
    const session = fakeSession(fakePage([]))
    const suspendStarted = Promise.withResolvers<void>()
    const releaseSuspend = Promise.withResolvers<void>()
    const suspend = session.suspend.bind(session)
    session.suspend = async () => {
      suspendStarted.resolve()
      await releaseSuspend.promise
      await suspend()
    }
    let resumes = 0
    const resumePage = session.resumePage.bind(session)
    session.resumePage = async () => {
      resumes++
      return resumePage()
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "arm-close-queue", command: { type: "stop" } })
    await suspendStarted.promise
    const close = BrowserCommandService.execute(owner, {
      commandId: "close-before-reload",
      command: { type: "close" },
    })
    const reload = BrowserCommandService.execute(owner, {
      commandId: "reload-after-close",
      command: { type: "reload" },
    })
    const reloadError = reload.catch((error: unknown) => error)
    releaseSuspend.resolve()

    await expect(close).resolves.toMatchObject({ type: "void" })
    expect(await reloadError).toMatchObject({ code: "browser_page_missing" })
    expect(resumes).toBe(0)
    expect(session.page).toBeNull()
  })

  test("retries failed idle suspension with a finite budget", async () => {
    const session = fakeSession(fakePage([]))
    let attempts = 0
    session.suspend = async () => {
      attempts++
      throw new Error("suspend failed")
    }
    restoreRuntime = BrowserCommandService.useRuntimeForTest(
      {
        async getOrCreateSession() {
          return session
        },
      },
      { ownerIdleMs: 10 },
    )

    await BrowserCommandService.execute(owner, { commandId: "retry-suspend", command: { type: "stop" } })
    await Bun.sleep(80)
    expect(attempts).toBe(4)
  })

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
