import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { BrowserOwner } from "../../src/browser/owner"
import { BrowserSessionImpl } from "../../src/browser/session"
import { BrowserStorage } from "../../src/browser/storage"
import { BrowserEvent } from "../../src/browser/event"
import type { BrowserBackendCommand, BrowserBackendResult, BrowserCheckpoint } from "@ericsanchezok/synergy-browser"
import type { BrowserPageBackend } from "../../src/browser/page"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope-lazy-browser",
  sessionID: "session-lazy-browser",
  directory: "/tmp/synergy-browser-lazy",
}

afterEach(async () => {
  await fs.rm(BrowserStorage.pathForOwner(owner), { force: true })
  BrowserEvent.remove(owner)
})

describe("BrowserSession lazy restore", () => {
  test("loads a suspended descriptor without asking for a browser driver", async () => {
    await BrowserStorage.save(owner, {
      status: "active",
      page: {
        id: "page-persisted",
        url: "https://example.com/",
        title: "Example",
        lastActiveAt: 10,
      },
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: [],
    })
    let driverRequests = 0
    const session = new BrowserSessionImpl(owner, async () => {
      driverRequests++
      throw new Error("driver must not be requested while restoring metadata")
    })

    expect(await session.restore()).toBe(true)
    expect(driverRequests).toBe(0)
    expect(session.page).toBeNull()
    expect(session.status).toBe("suspended")
    expect(session.descriptor).toEqual({
      id: "page-persisted",
      url: "https://example.com/",
      title: "Example",
      lastActiveAt: 10,
    })
  })

  test("persists a failed descriptor and structured recovery reason", async () => {
    await BrowserStorage.save(owner, {
      status: "active",
      page: {
        id: "page-recoverable",
        url: "https://example.com/recover",
        title: "Recoverable",
        lastActiveAt: 10,
      },
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: [],
    })
    const session = new BrowserSessionImpl(owner, async () => {
      throw new Error("browser executable unavailable")
    })
    await session.restore()

    await expect(session.resumePage()).rejects.toThrow("browser executable unavailable")
    expect(session.status).toBe("failed")
    expect(session.descriptor?.id).toBe("page-recoverable")
    expect(session.error).toMatchObject({
      type: "error",
      code: "browser_session_failed",
      message: "browser executable unavailable",
      retryable: true,
      pageId: "page-recoverable",
    })
    expect(await BrowserStorage.load(owner)).toMatchObject({
      status: "failed",
      page: { id: "page-recoverable" },
      error: { type: "error", code: "browser_session_failed" },
    })
  })

  test("migrates between backends with at most one live page", async () => {
    const events: string[] = []
    const protocolEvents: string[] = []
    const unsubscribe = BrowserEvent.subscribe(owner, (event) => protocolEvents.push(event.type))
    let livePages = 0
    let desired: BrowserPageBackend["backend"] = "headless"
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should satisfy both backends")
      },
      async ({ backend, id }) => {
        if (livePages !== 0) throw new Error("two browser pages became live")
        livePages++
        events.push(`create:${backend}`)
        return fakePage(backend, id ?? "page-migrate", events, () => livePages--)
      },
      () => desired,
    )

    const first = await session.ensurePage(undefined, { resume: false })
    expect(first.backend).toBe("headless")
    desired = "host"
    const migrated = await session.ensurePage(undefined, { resume: false })

    expect(migrated.backend).toBe("host")
    expect(livePages).toBe(1)
    expect(events.indexOf("close:headless")).toBeLessThan(events.indexOf("create:host"))
    expect(events).toContain("restore:host")
    expect(protocolEvents.slice(-2)).toEqual(["page.updated", "host.status"])
    unsubscribe()
    await session.closePage()
  })

  test("announces a ready Host after creating a page for an already-open Browser panel", async () => {
    const events: Array<{ type: string; pageId?: string; status?: string }> = []
    const unsubscribe = BrowserEvent.subscribe(owner, (event) => {
      if (event.type === "page.created") events.push({ type: event.type, pageId: event.page.id })
      if (event.type === "host.status") events.push({ type: event.type, pageId: event.pageId, status: event.status })
    })
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => fakePage("host", id ?? "page-host-ready", [], () => undefined),
      () => "host",
    )

    await session.ensurePage(undefined, { resume: false })

    expect(events).toEqual([
      { type: "page.created", pageId: "page-host-ready" },
      { type: "host.status", pageId: "page-host-ready", status: "ready" },
    ])
    unsubscribe()
    await session.closePage()
  })

  test("restores the original backend when target restore fails", async () => {
    const events: string[] = []
    let livePages = 0
    let desired: BrowserPageBackend["backend"] = "headless"
    let failHostRestore = true
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should satisfy both backends")
      },
      async ({ backend, id }) => {
        if (livePages !== 0) throw new Error("two browser pages became live")
        livePages++
        return fakePage(
          backend,
          id ?? "page-rollback",
          events,
          () => livePages--,
          () => {
            if (backend === "host" && failHostRestore) {
              failHostRestore = false
              throw new Error("host restore failed")
            }
          },
        )
      },
      () => desired,
    )
    await session.ensurePage(undefined, { resume: false })
    desired = "host"

    await expect(session.ensurePage(undefined, { resume: false })).rejects.toMatchObject({
      code: "browser_migration_failed",
      retryable: true,
    })
    expect(session.page?.backend).toBe("headless")
    expect(session.status).toBe("active")
    expect(livePages).toBe(1)
    await session.closePage()
  })

  test("closes the live page even when checkpoint capture fails during disposal", async () => {
    let closed = false
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => ({
        id: id ?? "page-dispose",
        backend: "headless",
        url: checkpoint.url,
        title: "Dispose",
        loading: false,
        lastActiveAt: 1,
        async execute(command) {
          if (command.type === "checkpoint" && command.action === "capture") {
            throw new Error("checkpoint capture failed")
          }
          return { type: "void" }
        },
        async close() {
          closed = true
        },
        isAlive() {
          return !closed
        },
      }),
      () => "headless",
    )
    await session.ensurePage(undefined, { resume: false })

    await expect(session.dispose()).rejects.toThrow("Browser session disposal did not complete cleanly")
    expect(closed).toBe(true)
    expect(session.page).toBeNull()
    expect(session.status).toBe("failed")
    expect(session.error).toMatchObject({ code: "browser_checkpoint_capture_failed", pageId: "page-dispose" })
  })

  test("suspends and resumes a headless page without replacing event subscribers", async () => {
    const protocolEvents: string[] = []
    const unsubscribe = BrowserEvent.subscribe(owner, (event) => protocolEvents.push(event.type))
    let livePages = 0
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => {
        livePages++
        return fakePage("headless", id ?? "page-idle-suspend", [], () => livePages--)
      },
      () => "headless",
    )
    const first = await session.ensurePage(undefined, { resume: false })

    await session.suspend()
    expect(livePages).toBe(0)
    expect(session.page).toBeNull()
    expect(session.status).toBe("suspended")
    expect(session.descriptor?.id).toBe(first.id)
    expect(protocolEvents.at(-1)).toBe("page.closed")

    const resumed = await session.resumePage()
    expect(resumed.id).toBe(first.id)
    expect(livePages).toBe(1)
    expect(protocolEvents.at(-1)).toBe("page.created")
    unsubscribe()
    await session.closePage()
  })

  test("saves live context storage before closing a headless page for suspension", async () => {
    const events: string[] = []
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) =>
        fakePage(
          "headless",
          id ?? "page-idle-storage",
          events,
          () => undefined,
          undefined,
          () => {
            events.push("save-storage")
          },
        ),
      () => "headless",
    )
    await session.ensurePage(undefined, { resume: false })
    events.length = 0

    await session.suspend()

    expect(events).toEqual(["capture:headless", "save-storage", "close:headless"])
  })

  test("keeps the live page when suspension storage persistence fails", async () => {
    const events: string[] = []
    let failPersistence = false
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) =>
        fakePage(
          "headless",
          id ?? "page-idle-storage-failure",
          events,
          () => undefined,
          undefined,
          () => {
            events.push("save-storage")
            if (failPersistence) throw new Error("storage persistence failed")
          },
        ),
      () => "headless",
    )
    await session.ensurePage(undefined, { resume: false })
    events.length = 0
    failPersistence = true

    await expect(session.suspend()).rejects.toThrow("storage persistence failed")

    expect(events).toEqual(["capture:headless", "save-storage"])
    expect(session.page?.id).toBe("page-idle-storage-failure")
    expect(session.status).toBe("active")
  })

  test("retries residual owner cleanup after the headless page has already closed", async () => {
    let closeAttempts = 0
    let alive = true
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => ({
        id: id ?? "page-suspend-cleanup",
        backend: "headless",
        url: checkpoint.url,
        title: "Suspend cleanup",
        loading: false,
        lastActiveAt: 1,
        async execute(command) {
          if (command.type === "checkpoint" && command.action === "capture") {
            return { type: "data", pageId: id ?? "page-suspend-cleanup", data: checkpoint }
          }
          return { type: "void" }
        },
        async close() {
          closeAttempts++
          alive = false
          if (closeAttempts === 1) throw new Error("owner cleanup failed")
        },
        isAlive() {
          return alive
        },
      }),
      () => "headless",
    )
    await session.ensurePage(undefined, { resume: false })

    await expect(session.suspend()).rejects.toThrow("Browser session disposal did not complete cleanly")
    expect(session.page).toBeNull()
    expect(session.status).toBe("failed")
    expect(closeAttempts).toBe(1)

    await session.suspend()
    expect(closeAttempts).toBe(2)
    expect(session.status).toBe("suspended")
    expect(session.descriptor?.id).toBe("page-suspend-cleanup")
    expect(session.error).toBeNull()
  })

  test("removes a dead page reference when close reports a cleanup failure", async () => {
    let closed = false
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => ({
        id: id ?? "page-close-cleanup",
        backend: "headless",
        url: checkpoint.url,
        title: "Close cleanup",
        loading: false,
        lastActiveAt: 1,
        async execute() {
          return { type: "void" }
        },
        async close() {
          closed = true
          throw new Error("context cleanup failed")
        },
        isAlive() {
          return !closed
        },
      }),
      () => "headless",
    )
    await session.ensurePage(undefined, { resume: false })

    await expect(session.closePage()).rejects.toMatchObject({ code: "browser_page_cleanup_failed" })
    expect(session.page).toBeNull()
    expect(session.status).toBe("empty")
    expect(await BrowserStorage.load(owner)).toMatchObject({ status: "empty", page: null })
  })
  test("keeps the live failed host page and clears the failure through resume", async () => {
    const handlers: { onError?: (page: BrowserPageBackend, message: string) => void } = {}
    let resumed = 0
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id, events }) => {
        handlers.onError = events.onError
        return {
          id: id ?? "page-native-failed",
          backend: "host",
          url: checkpoint.url,
          title: "Recoverable",
          loading: false,
          lastActiveAt: 1,
          async execute(command) {
            if (command.type === "resume") {
              resumed++
              return {
                type: "page",
                page: {
                  id: id ?? "page-native-failed",
                  url: checkpoint.url,
                  title: "Recoverable",
                  isLoading: false,
                  lastActiveAt: 1,
                },
              }
            }
            return { type: "void" }
          },
          async close() {},
          isAlive() {
            return true
          },
        }
      },
      () => "host",
    )
    await session.ensurePage(undefined, { resume: false })
    expect(session.status).toBe("active")

    handlers.onError?.(session.page!, "The Desktop native Browser could not recover after repeated attempts.")
    await session.save()
    expect(session.status).toBe("failed")
    expect(session.error).toMatchObject({
      type: "error",
      code: "browser_native_recovery_failed",
      retryable: true,
      pageId: "page-native-failed",
      url: checkpoint.url,
    })
    const persisted = await BrowserStorage.load(owner)
    expect(persisted).toMatchObject({
      status: "failed",
      page: { id: "page-native-failed" },
      error: { code: "browser_native_recovery_failed" },
    })

    const resumedPage = await session.resumePage()
    expect(resumedPage.id).toBe("page-native-failed")
    expect(resumed).toBe(1)
    expect(session.status).toBe("active")
    expect(session.error).toBeNull()
    expect(await BrowserStorage.load(owner)).toMatchObject({ status: "active", page: { id: "page-native-failed" } })
  })

  test("resume on a healthy live page is idempotent and keeps the same page identity", async () => {
    const executions: string[] = []
    let created = 0
    const session = new BrowserSessionImpl(
      owner,
      async () => {
        throw new Error("the injected page factory should be used")
      },
      async ({ id }) => {
        created++
        return {
          id: id ?? "page-healthy-resume",
          backend: "host",
          url: checkpoint.url,
          title: "Healthy",
          loading: false,
          lastActiveAt: 1,
          async execute(command) {
            executions.push(command.type)
            if (command.type === "resume") {
              return {
                type: "page",
                page: {
                  id: id ?? "page-healthy-resume",
                  url: checkpoint.url,
                  title: "Healthy",
                  isLoading: false,
                  lastActiveAt: 1,
                },
              }
            }
            return { type: "void" }
          },
          async close() {},
          isAlive() {
            return true
          },
        }
      },
      () => "host",
    )
    const page = await session.ensurePage(undefined, { resume: false })
    expect(session.status).toBe("active")

    const first = await session.resumePage()
    const second = await session.resumePage()

    expect(first).toBe(page)
    expect(second).toBe(page)
    expect(created).toBe(1)
    expect(executions).toEqual(["resume", "resume"])
    expect(session.status).toBe("active")
    expect(session.error).toBeNull()
    expect(await BrowserStorage.load(owner)).toMatchObject({
      status: "active",
      page: { id: "page-healthy-resume" },
    })
  })
})

const checkpoint: BrowserCheckpoint = {
  url: "https://example.com/",
  cookies: [],
  origins: [],
  viewport: { width: 1280, height: 720 },
  scroll: { x: 0, y: 10 },
  formState: [],
}

function fakePage(
  backend: BrowserPageBackend["backend"],
  id: string,
  events: string[],
  closed: () => void,
  beforeRestore?: () => void,
  saveContextStorage?: () => Promise<void> | void,
): BrowserPageBackend {
  let isClosed = false
  return {
    id,
    backend,
    url: checkpoint.url,
    title: "Example",
    loading: false,
    lastActiveAt: 1,
    async execute(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
      if (command.type === "checkpoint" && command.action === "capture") {
        events.push(`capture:${backend}`)
        return { type: "data", pageId: id, data: checkpoint }
      }
      if (command.type === "checkpoint" && command.action === "restore") {
        events.push(`restore:${backend}`)
        beforeRestore?.()
        return { type: "data", pageId: id, data: { restored: true } }
      }
      return { type: "void" }
    },
    async saveContextStorage() {
      await saveContextStorage?.()
    },
    async close() {
      if (isClosed) return
      isClosed = true
      events.push(`close:${backend}`)
      closed()
    },
    isAlive() {
      return !isClosed
    },
  }
}
