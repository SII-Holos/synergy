import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { BrowserOwner } from "../../src/browser/owner"
import { BrowserSessionImpl } from "../../src/browser/session"
import { BrowserStorage } from "../../src/browser/storage"
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
