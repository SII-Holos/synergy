import { afterAll, afterEach, expect, test, spyOn } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
  type BrowserBackendResult,
} from "@ericsanchezok/synergy-browser"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { BrowserRuntime } from "../src/runtime"
import { BrowserCommandService } from "../src/command-service"
import { BrowserOwner } from "../src/owner"
import { BrowserStorage } from "../src/storage"
import { BrowserBroker, type BrowserBrokerSocket } from "../src/broker"
import { BrowserEvent } from "../src/event"
import { testRuntime } from "./support/runtime"

const runtime = await testRuntime(registerLocalRuntime)
afterAll(() => runtime.close())
afterEach(() =>
  runtime.run(async () => {
    await BrowserRuntime.stop()
    BrowserBroker.resetForTest()
  }),
)

function owner(session: Session.Info): BrowserOwner.Info {
  return BrowserOwner.fromRoute({
    scopeID: session.scope.id,
    directory: session.workspace?.path ?? null,
    sessionID: session.id,
    workspaceID: session.workspaceID,
    generation: session.workspace?.generation,
  })
}

test("switching Workspace retires the old browser before commit while preserving presentation and history", () =>
  runtime.run(async () => {
    await using first = await tmpdir(),
      second = await tmpdir()
    await ScopeContext.provide({
      scope: await first.scope(),
      async fn() {
        const session = await Session.create({})
        const original = owner(session)
        await BrowserStorage.save(original, {
          status: "suspended",
          page: { id: "preserved-page", url: "https://example.com/", title: "Preserved" },
          timestamp: Date.now(),
        })
        BrowserBroker.attach(
          { send() {}, close() {} },
          {
            type: "host.register",
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            hostId: "workspace-test",
            token: BrowserBroker.secret(),
            capabilities: { native: true, webrtc: true },
          },
        )
        BrowserBroker.prepare(original, first.path, "webrtc")
        const watermark = BrowserEvent.watermark(original)
        const browser = await BrowserRuntime.getOrCreateSession(original)
        const disposed = spyOn(browser, "dispose")
        try {
          const target = WorkspaceCatalog.projection(await WorkspaceBinding.register(session.scope.id, second.path))
          const updated = await Session.updateWorkspace(session.id, target)
          expect(disposed).toHaveBeenCalledTimes(1)
          const current = await BrowserRuntime.getOrCreateSession(owner(updated))
          expect(current).not.toBe(browser)
          expect(current.owner.directory).toBe(second.path)
          expect(current.descriptor?.id).toBe("preserved-page")
          expect(BrowserBroker.preference(original)).toEqual({ presentation: "webrtc", routeDirectory: first.path })
          expect(BrowserEvent.watermark(original).epoch).toBe(watermark.epoch)
          await expect(BrowserRuntime.getOrCreateSession(original)).rejects.toThrow()
        } finally {
          disposed.mockRestore()
        }
      },
    })
  }))

class WorkspaceHost implements BrowserBrokerSocket {
  requests: BrowserHostMessage[] = []
  pages = new Map<string, { id: string; url: string; title: string; isLoading: boolean; lastActiveAt: number | null }>()
  beforeReply?: (message: BrowserHostMessage) => Promise<void>
  failClose = false

  send(data: string) {
    const message = BrowserHostMessageSchema.parse(JSON.parse(data))
    this.requests.push(message)
    if (message.type !== "page.create" && message.type !== "page.close" && message.type !== "page.command") return
    void this.respond(message)
  }
  close() {}

  private async respond(message: Extract<BrowserHostMessage, { type: "page.create" | "page.close" | "page.command" }>) {
    await this.beforeReply?.(message)
    if (message.type === "page.close" && this.failClose) {
      BrowserBroker.handle(this, {
        type: "page.result",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: message.requestId,
        error: { type: "error", code: "test_close_failed", message: "Host close failed", retryable: true },
      })
      return
    }
    let result: BrowserBackendResult = { type: "void" }
    if (message.type === "page.create") {
      this.pages.set(message.page.id, { ...message.page })
      result = { type: "page", page: message.page }
    } else if (message.type === "page.close") {
      this.pages.delete(message.pageId)
    } else {
      const page = this.pages.get(message.pageId)!
      if (message.command.type === "navigate") {
        page.url = message.command.url
        result = { type: "navigation", page: { ...page } }
      } else if (message.command.type === "checkpoint" && message.command.action === "capture") {
        result = {
          type: "data",
          pageId: page.id,
          data: { url: page.url, viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 0 } },
        }
      }
    }
    BrowserBroker.handle(this, {
      type: "page.result",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: message.requestId,
      result,
    })
  }

  attach() {
    BrowserBroker.attach(this, {
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "workspace-host",
      token: BrowserBroker.secret(),
      capabilities: { native: true, webrtc: true },
    })
  }
}

test("Workspace selection drains an active Host command and acknowledges page closure before committing", () =>
  runtime.run(async () => {
    await using first = await tmpdir(),
      second = await tmpdir()
    await ScopeContext.provide({
      scope: await first.scope(),
      async fn() {
        const session = await Session.create({})
        const original = owner(session)
        const host = new WorkspaceHost()
        host.attach()
        BrowserBroker.prepare(original, first.path, "native")
        const entered = Promise.withResolvers<void>(),
          finish = Promise.withResolvers<void>()
        const closing = Promise.withResolvers<void>(),
          closed = Promise.withResolvers<void>()
        host.beforeReply = async (message) => {
          if (message.type === "page.command" && message.command.type === "navigate") {
            entered.resolve()
            await finish.promise
          }
          if (message.type === "page.close") {
            closing.resolve()
            await closed.promise
          }
        }
        const command = BrowserCommandService.execute(original, {
          commandId: "in-flight",
          command: { type: "navigate", url: "https://example.com/", source: "user" },
        })
        await entered.promise
        const target = WorkspaceCatalog.projection(await WorkspaceBinding.register(session.scope.id, second.path))
        const switching = Session.updateWorkspace(session.id, target)
        const cancel = new AbortController()
        const queued = BrowserCommandService.execute(original, {
          commandId: "cancelled",
          command: { type: "close" },
          signal: cancel.signal,
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        cancel.abort(new Error("queued browser cancelled"))
        expect(await queued).toMatchObject({ message: "queued browser cancelled" })
        expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID)
        expect(host.requests.filter((entry) => entry.type === "page.close")).toHaveLength(0)
        finish.resolve()
        await command
        await closing.promise
        expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID)
        expect(host.pages.size).toBe(1)
        closed.resolve()
        const updated = await switching
        expect(updated.workspaceID).toBe(target!.id!)
        expect(host.pages.size).toBe(0)
        await BrowserCommandService.execute(owner(updated), {
          commandId: "new-context",
          command: { type: "navigate", url: "https://example.com/next", source: "user" },
        })
        const creation = host.requests.filter((entry) => entry.type === "page.create").at(-1)!
        expect(creation.owner.directory).toBe(second.path)
        expect(host.pages.size).toBe(1)
      },
    })
  }))

test("a failed Host closure preserves the binding and a retry revokes the old local-file authority", () =>
  runtime.run(async () => {
    await using first = await tmpdir(),
      second = await tmpdir()
    await ScopeContext.provide({
      scope: await first.scope(),
      async fn() {
        const session = await Session.create({})
        const original = owner(session)
        const host = new WorkspaceHost()
        host.attach()
        BrowserBroker.prepare(original, first.path, "webrtc")
        const filename = path.join(first.path, "index.html")
        await Bun.write(filename, "<h1>Workspace</h1>")
        await BrowserCommandService.execute(original, {
          commandId: "local",
          command: { type: "navigate", url: pathToFileURL(filename).href, source: "user" },
        })
        const target = WorkspaceCatalog.projection(await WorkspaceBinding.register(session.scope.id, second.path))
        host.failClose = true
        await expect(Session.updateWorkspace(session.id, target)).rejects.toThrow()
        expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID)
        expect(host.pages.size).toBe(1)
        host.failClose = false
        const updated = await Session.updateWorkspace(session.id, target)
        expect(host.pages.size).toBe(0)
        await expect(
          BrowserCommandService.execute(owner(updated), { commandId: "resume-old-file", command: { type: "resume" } }),
        ).rejects.toThrow()
        expect(host.pages.size).toBe(0)
        expect(host.requests.filter((entry) => entry.type === "page.create")).toHaveLength(1)
      },
    })
  }))

test(
  "rebinding a Workspace retires its browser resources and old replay results",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create({})
          const original = owner(session)
          const browser = await BrowserRuntime.getOrCreateSession(original)
          const close = spyOn(browser, "closePage")
          await BrowserCommandService.execute(original, { commandId: "repeat", command: { type: "close" } })
          const record = await WorkspaceCatalog.get(session.workspaceID!, session.scope.id)
          const deadline = Date.now() + 15000
          for (;;) {
            try {
              await WorkspaceBinding.rebind(record.id, {
                scopeID: session.scope.id,
                expectedRevision: record.revision,
                path: tmp.path,
              })
              break
            } catch (error) {
              if (!(error instanceof WorkspaceAccess.BusyError) || Date.now() >= deadline) throw error
              await Bun.sleep(50)
            }
          }
          const updated = owner(await Session.get(session.id))
          const current = await BrowserRuntime.getOrCreateSession(updated)
          expect(current).not.toBe(browser)
          await expect(BrowserRuntime.getOrCreateSession(original)).rejects.toThrow()
          const closeCurrent = spyOn(current, "closePage")
          try {
            await BrowserCommandService.execute(updated, { commandId: "repeat", command: { type: "close" } })
            expect(closeCurrent).toHaveBeenCalledTimes(1)
            expect(close).toHaveBeenCalledTimes(1)
          } finally {
            close.mockRestore()
            closeCurrent.mockRestore()
          }
        },
      })
    }),
  20000,
)
