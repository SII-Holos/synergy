import { afterAll, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  BrowserSessionPageSchema,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { BrowserBroker } from "../../src/broker"
import { BrowserEvent } from "../../src/event"
import { BrowserHostPage } from "../../src/host-page"
import { BrowserOwner } from "../../src/owner"
import { BrowserProfiles } from "../../src/profiles"
import { BrowserRoute } from "../../src/routes/browser-route"
import { BrowserSessionImpl } from "../../src/session"
import { BrowserStorage } from "../../src/storage"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime(() =>
  Server.registerContributions({ routes: { "scoped-after-assets": BrowserRoute() } }),
)
afterAll(() => runtime.close())

test(
  "real broker reconnects after an empty page error without replaying an uncertain command",
  () =>
    runtime.run(async () => {
      const server = Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false })
      const owner: BrowserOwner.Info = { mode: "scope", scopeID: Scope.home().id, directory: null }
      const profile = await BrowserProfiles.defaultProfile()
      const session = new BrowserSessionImpl(owner, (input) =>
        BrowserHostPage.create({ ...input, owner, presentation: "native", routeDirectory: "home" }),
      )
      const hosts: ReturnType<typeof connectHost>[] = []
      const stopFaultyObserver = BrowserEvent.subscribe(owner, (event) => {
        if (event.type === "page.updated") throw new Error("faulty observer")
      })
      try {
        const first = connectHost(server.url, BrowserBroker.secret(), "first")
        hosts.push(first)
        await first.ready
        const page = await session.openPage({ url: "https://example.com/", profileId: profile.id })
        first.send({
          type: "page.event",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: BrowserOwner.key(owner),
          pageId: page.id,
          event: { type: "page.error", pageId: page.id, message: "" },
        })
        await waitFor(() => Boolean(session.describe(page.id).error))
        const errored = BrowserSessionPageSchema.parse(session.describe(page.id))
        expect(errored.error?.message).toBe("Browser page reported an error without a description.")
        await session.save()
        expect((await BrowserStorage.load(owner))?.pages[0]?.error).toEqual(errored.error)

        const unknownOutcome = page
          .execute({ type: "evaluate", mode: "trusted", expression: "window.counter++" })
          .catch((error: unknown) => error)
        await waitFor(() => first.messages.some((message) => message.type === "page.command"))
        first.socket.close()
        expect(await unknownOutcome).toBeInstanceOf(Error)
        await waitFor(() => !BrowserBroker.ready())
        expect(page.isAlive()).toBe(false)
        expect(session.describe(page.id).status).toBe("suspended")

        const replacement = connectHost(server.url, BrowserBroker.secret(), "replacement")
        hosts.push(replacement)
        await replacement.ready
        expect(BrowserBroker.ready()).toBe(true)
        expect(replacement.messages.map((message) => message.type)).toEqual(["host.registered"])
        const resumed = await session.resumePage(page.id)
        expect(resumed.id).toBe(page.id)
        expect(resumed).not.toBe(page)
        expect(session.describe(page.id)).toMatchObject({ status: "active", profileId: profile.id })
        expect(session.describe(page.id).error).toBeUndefined()
        expect(replacement.messages.filter((message) => message.type === "page.create")).toHaveLength(1)
        expect(replacement.messages.some((message) => message.type === "page.command")).toBe(false)
        await session.dispose()
      } finally {
        stopFaultyObserver()
        for (const host of hosts) host.socket.close()
        await server.stop(true)
        BrowserBroker.resetForTest()
        await session.dispose()
      }
    }),
  20_000,
)

function connectHost(serverURL: URL, token: string, hostId: string) {
  const url = new URL(`/browser/host/broker?protocolVersion=${BROWSER_PROTOCOL_VERSION}`, serverURL)
  url.protocol = "ws:"
  const socket = new WebSocket(url)
  const registered = Promise.withResolvers<void>()
  const messages: BrowserHostMessage[] = []
  const timer = setTimeout(() => registered.reject(new Error("Host registration timed out")), 5_000)
  const send = (message: BrowserHostMessage) => socket.send(JSON.stringify(message))
  socket.onopen = () =>
    send({
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      token,
      hostId,
      capabilities: { native: true },
    })
  socket.onmessage = (event) => {
    try {
      const message = BrowserHostMessageSchema.parse(JSON.parse(String(event.data)))
      messages.push(message)
      if (message.type === "host.registered") registered.resolve()
      if (message.type === "page.create" || message.type === "page.close") {
        send({
          type: "page.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: message.requestId,
          result: message.type === "page.create" ? { type: "page", page: message.page } : { type: "void" },
        })
      }
    } catch (error) {
      registered.reject(error)
    }
  }
  socket.onerror = () => registered.reject(new Error("Host WebSocket failed"))
  socket.onclose = () => registered.reject(new Error("Host closed before registration"))
  return { socket, messages, send, ready: registered.promise.finally(() => clearTimeout(timer)) }
}

async function waitFor(read: () => boolean) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (read()) return
    await Bun.sleep(10)
  }
  throw new Error("Broker recovery condition did not converge")
}
