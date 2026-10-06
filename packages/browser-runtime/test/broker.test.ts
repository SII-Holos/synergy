import { BrowserProfiles } from "../src/profiles"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, type BrowserHostMessage } from "@ericsanchezok/synergy-browser-core"
import { BrowserBroker, type BrowserBrokerSocket } from "../src/broker"
import { BrowserEvent } from "../src/event"
import { BrowserStorage } from "../src/storage"
import type { BrowserOwner } from "../src/owner"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

class Socket implements BrowserBrokerSocket {
  sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

afterEach(() =>
  runtime.run(() => {
    BrowserBroker.resetForTest()
    BrowserEvent.resetForTest()
  }),
)

describe("Browser Host broker authentication", () => {
  test("accepts only the registration secret and rejects events for unknown owner pages", () =>
    runtime.run(() => {
      const forged = new Socket()
      expect(() =>
        BrowserBroker.attach(forged, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "forged",
          token: "0".repeat(64),
          capabilities: { native: true },
        }),
      ).toThrow(/secret/i)
      expect(forged.closed?.code).toBe(1008)

      const host = new Socket()
      BrowserBroker.attach(host, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host",
        token: BrowserBroker.secret(),
        capabilities: { native: true },
      })
      expect(BrowserBroker.ready("native")).toBe(true)
      expect(host.sent).toContainEqual({
        type: "host.registered",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host",
      })

      const replacement = new Socket()
      expect(() =>
        BrowserBroker.attach(replacement, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "replacement",
          token: BrowserBroker.secret(),
          capabilities: { native: true },
        }),
      ).toThrow(/already registered/i)
      expect(replacement.closed?.code).toBe(1013)
      expect(BrowserBroker.ready("native")).toBe(true)

      BrowserBroker.handle(host, {
        type: "page.event",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: "another-owner",
        pageId: "unknown-page",
        event: { type: "page.error", pageId: "unknown-page", message: "forged event" },
      })
      expect(host.closed?.code).toBe(1008)
    }))

  test("forwards page-scoped native recovery status through the canonical event stream", () =>
    runtime.run(async () => {
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID: "scope-test",
        sessionID: "session-test",
        directory: "/tmp",
      }
      const host = new (class extends Socket {
        override send(data: string): void {
          const message = JSON.parse(data) as BrowserHostMessage
          this.sent.push(message)
          if (message.type !== "page.create") return
          queueMicrotask(() =>
            BrowserBroker.handle(this, {
              type: "page.result",
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { type: "page", page: message.page },
            }),
          )
        }
      })()
      BrowserBroker.attach(host, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host-recovery",
        token: BrowserBroker.secret(),
        capabilities: { native: true },
      })
      BrowserBroker.prepare(owner, "home", "native")
      await BrowserBroker.createPage({
        profile: await BrowserProfiles.defaultProfile(),
        owner,
        routeDirectory: "home",
        presentation: "native",
        pageId: "page-test",
      })
      const statuses: string[] = []
      const unsubscribe = BrowserEvent.subscribe(owner, (event) => {
        if (event.type === "host.status") statuses.push(`${event.pageId}:${event.status}`)
      })

      BrowserBroker.handle(host, {
        type: "page.event",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: "scope:scope-test:session:session-test",
        pageId: "page-test",
        event: { type: "host.status", pageId: "page-test", status: "restarting" },
      })

      expect(statuses).toEqual(["page-test:restarting"])
      unsubscribe()
      BrowserEvent.remove(owner)
    }))

  test("disconnect publishes per-page restarting before the error, then an owner-wide restarting status", () =>
    runtime.run(async () => {
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID: "scope-disconnect",
        sessionID: "session-disconnect",
        directory: "/tmp",
      }
      const host = new (class extends Socket {
        override send(data: string): void {
          const message = JSON.parse(data) as BrowserHostMessage
          this.sent.push(message)
          if (message.type !== "page.create") return
          queueMicrotask(() =>
            BrowserBroker.handle(this, {
              type: "page.result",
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              requestId: message.requestId,
              result: { type: "page", page: message.page },
            }),
          )
        }
      })()
      BrowserBroker.prepare(owner, "home", "native")
      BrowserBroker.attach(host, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host-disconnect-order",
        token: BrowserBroker.secret(),
        capabilities: { native: true },
      })
      await BrowserBroker.createPage({
        profile: await BrowserProfiles.defaultProfile(),
        owner,
        routeDirectory: "home",
        presentation: "native",
        pageId: "page-disconnect",
      })

      const canonical: string[] = []
      const pageScoped: string[] = []
      const unsubscribeCanonical = BrowserEvent.subscribe(owner, (event) => {
        if (event.type === "host.status") canonical.push(`status:${event.pageId ?? "owner"}:${event.status}`)
      })
      const unsubscribePage = BrowserBroker.subscribe(owner, "page-disconnect", (event) => {
        if (event.type === "host.status") pageScoped.push(`status:${event.pageId}:${event.status}`)
        if (event.type === "page.error") pageScoped.push(`error:${event.pageId}`)
      })

      BrowserBroker.detach(host)

      expect(pageScoped).toEqual(["status:page-disconnect:restarting", "error:page-disconnect"])
      expect(canonical).toEqual(["status:page-disconnect:restarting", "status:owner:restarting"])
      unsubscribeCanonical()
      unsubscribePage()
      BrowserEvent.remove(owner)
    }))

  test("reentrant replacement registration completes the old lifecycle fan-out before ready", () =>
    runtime.run(() => {
      const owners = ["first", "second"].map((scopeID) => ({ mode: "scope" as const, scopeID, directory: null }))
      const original = new Socket()
      const replacement = new Socket()
      const register = (socket: Socket, hostId: string) =>
        BrowserBroker.attach(socket, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId,
          token: BrowserBroker.secret(),
          capabilities: { native: true },
        })
      register(original, "original")
      for (const owner of owners) BrowserBroker.prepare(owner, "home", "native")
      let replaced = false
      const replace = BrowserEvent.subscribe(owners[0]!, (event) => {
        if (event.type !== "host.status" || event.status !== "restarting" || replaced) return
        replaced = true
        register(replacement, "replacement")
      })
      const received = owners.map(() => [] as { seq: number; status: string }[])
      const observers = owners.map((owner, index) =>
        BrowserEvent.subscribe(owner, (event) => {
          if (event.type === "host.status") received[index]!.push({ seq: event.seq, status: event.status })
        }),
      )
      try {
        BrowserBroker.detach(original)
        expect(BrowserBroker.ready()).toBe(true)
        for (const events of received) {
          expect(events).toEqual([
            { seq: 1, status: "restarting" },
            { seq: 2, status: "ready" },
          ])
        }
      } finally {
        replace()
        for (const unsubscribe of observers) unsubscribe()
        for (const owner of owners) BrowserEvent.remove(owner)
      }
    }))

  test("reentrant detach releases old identity before replacement reserves the same page", () =>
    runtime.run(async () => {
      const owner: BrowserOwner.Info = { mode: "scope", scopeID: "reentrant-resource", directory: null }
      const originalProfile = await BrowserProfiles.create({ name: "Original", kind: "temporary" })
      const replacementProfile = await BrowserProfiles.create({ name: "Replacement", kind: "temporary" })
      const original = new Socket()
      const replacement = new Socket()
      const directories = Promise.withResolvers<void>()
      const ensureDirectories = spyOn(BrowserStorage, "ensureOwnerDirs").mockImplementation(() => directories.promise)
      const creations: Promise<unknown>[] = []
      const register = (socket: Socket, hostId: string) =>
        BrowserBroker.attach(socket, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId,
          token: BrowserBroker.secret(),
          capabilities: { native: true },
        })
      const create = (profile: BrowserProfiles.Stored) =>
        creations.push(
          BrowserBroker.createPage({
            owner,
            routeDirectory: "home",
            presentation: "native",
            pageId: "same-page",
            profile,
          }).catch((error: unknown) => error),
        )
      BrowserBroker.prepare(owner, "home", "native")
      let replaced = false
      const unsubscribe = BrowserEvent.subscribe(owner, (event) => {
        if (event.type !== "host.status" || event.status !== "ready" || replaced) return
        replaced = true
        create(originalProfile)
        BrowserBroker.detach(original)
        register(replacement, "replacement")
        create(replacementProfile)
      })
      try {
        register(original, "original")
        expect(BrowserBroker.hasPage(owner, "same-page")).toBe(true)
        await expect(BrowserProfiles.get(originalProfile.id)).rejects.toBeInstanceOf(Error)
        expect((await BrowserProfiles.get(replacementProfile.id)).id).toBe(replacementProfile.id)
      } finally {
        unsubscribe()
        directories.reject(new Error("creation stopped at the storage boundary"))
        await Promise.all(creations)
        ensureDirectories.mockRestore()
        BrowserBroker.detach(replacement)
        BrowserProfiles.releaseTemporary(originalProfile.id)
        BrowserProfiles.releaseTemporary(replacementProfile.id)
      }
    }))

  test("a failed reentrant handshake drains teardown and allows the next registration", () =>
    runtime.run(() => {
      const owner: BrowserOwner.Info = { mode: "scope", scopeID: "handshake-failure", directory: null }
      const original = new Socket()
      const failed = new (class extends Socket {
        override send(): void {
          throw new Error("handshake failed")
        }
      })()
      const register = (socket: Socket, hostId: string) =>
        BrowserBroker.attach(socket, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId,
          token: BrowserBroker.secret(),
          capabilities: { native: true },
        })
      register(original, "original")
      BrowserBroker.prepare(owner, "home", "native")
      let replaced = false
      const unsubscribe = BrowserEvent.subscribe(owner, (event) => {
        if (event.type !== "host.status" || event.status !== "restarting" || replaced) return
        replaced = true
        register(failed, "failed")
      })
      try {
        expect(() => BrowserBroker.detach(original)).toThrow("handshake failed")
        expect(BrowserBroker.ready()).toBe(false)
        const replacement = new Socket()
        expect(() => register(replacement, "replacement")).not.toThrow()
        expect(BrowserBroker.ready()).toBe(true)
        expect(replacement.sent).toContainEqual({
          type: "host.registered",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "replacement",
        })
      } finally {
        unsubscribe()
      }
    }))

  test.each(["page", "owner", "activity"] as const)(
    "disconnect survives a failing %s observer and admits a new host",
    (boundary) =>
      runtime.run(async () => {
        const owner: BrowserOwner.Info = { mode: "scope", scopeID: `disconnect-${boundary}`, directory: null }
        const host = new (class extends Socket {
          override send(data: string): void {
            const message = JSON.parse(data) as BrowserHostMessage
            this.sent.push(message)
            if (message.type !== "page.create") return
            queueMicrotask(() =>
              BrowserBroker.handle(this, {
                type: "page.result",
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                requestId: message.requestId,
                result: { type: "page", page: message.page },
              }),
            )
          }
        })()
        const register = (socket: Socket, hostId: string) =>
          BrowserBroker.attach(socket, {
            type: "host.register",
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            hostId,
            token: BrowserBroker.secret(),
            capabilities: { native: true },
          })
        register(host, "original")
        const profile = await BrowserProfiles.create({ name: "Disconnect fixture", kind: "temporary" })
        for (const pageId of ["first", "second"]) {
          await BrowserBroker.createPage({ owner, routeDirectory: "home", presentation: "native", pageId, profile })
        }
        const pending = BrowserBroker.command(owner, "second", {
          type: "evaluate",
          expression: "1",
          mode: "readonly",
        }).catch((error: unknown) => error)
        let failures = 0
        const fail = () => {
          failures++
          throw new Error("Observer failed")
        }
        const unsubscribeFailure =
          boundary === "page"
            ? BrowserBroker.subscribe(owner, "first", fail)
            : boundary === "owner"
              ? BrowserEvent.subscribe(owner, (event) => {
                  if (event.type === "host.status") fail()
                })
              : BrowserBroker.onActivity(fail)
        const pageEvents: string[] = []
        const unsubscribePages = ["first", "second"].map((pageId) =>
          BrowserBroker.subscribe(owner, pageId, (event) => {
            if (event.type === "host.status") pageEvents.push(`${pageId}:${event.status}`)
            if (event.type === "page.error") pageEvents.push(`${pageId}:error`)
          }),
        )
        const statuses: string[] = []
        const unsubscribeOwner = BrowserEvent.subscribe(owner, (event) => {
          if (event.type === "host.status") statuses.push(`${event.pageId ?? "owner"}:${event.status}`)
        })
        const activity: boolean[] = []
        const unsubscribeActivity = BrowserBroker.onActivity((hasPages) => activity.push(hasPages))
        try {
          expect(() => BrowserBroker.detach(host)).not.toThrow()
          expect(failures).toBeGreaterThan(0)
          expect(BrowserBroker.ready()).toBe(false)
          expect(await pending).toBeInstanceOf(Error)
          expect(pageEvents).toEqual(["first:restarting", "first:error", "second:restarting", "second:error"])
          expect(statuses).toEqual(["first:restarting", "second:restarting", "owner:restarting"])
          expect(activity).toEqual([false])
          await expect(BrowserProfiles.get(profile.id)).rejects.toThrow()
          unsubscribeFailure()
          const replacement = new Socket()
          register(replacement, "replacement")
          BrowserBroker.detach(host)
          expect(BrowserBroker.ready("native")).toBe(true)
          expect(BrowserBroker.hasPage(owner, "first")).toBe(false)
          expect(replacement.sent).toEqual([
            { type: "host.registered", protocolVersion: BROWSER_PROTOCOL_VERSION, hostId: "replacement" },
          ])
        } finally {
          unsubscribeFailure()
          for (const unsubscribe of unsubscribePages) unsubscribe()
          unsubscribeOwner()
          unsubscribeActivity()
          BrowserEvent.remove(owner)
        }
      }),
  )
})

afterRuntimeTests(() => runtime.close())
