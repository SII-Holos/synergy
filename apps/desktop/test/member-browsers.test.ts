import { afterEach, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import {
  BROWSER_PROTOCOL_VERSION as protocolVersion,
  BrowserHostMessageSchema,
  browserOwnerKey,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import type { BrowserNativePageInput, BrowserNativePagePool } from "../src/browser-native-page-pool"
import { DEFAULT_DESKTOP_SHELL_SKIN } from "../src/default-shell-skin.generated"
import { desktopThemeSnapshot } from "../src/theme"
import { registerElectronMock } from "./electron-mock"

registerElectronMock()
const { DesktopMemberBrowsers } = await import("../src/organization/member-browsers")
const theme = desktopThemeSnapshot({ version: 2, source: "system", ...DEFAULT_DESKTOP_SHELL_SKIN }, false)
const owner = { mode: "session" as const, scopeID: "scope", sessionID: "session", directory: null }
const ownerKey = browserOwnerKey(owner)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Member Browser condition timed out")
    await Bun.sleep(5)
  }
}

function server(connectionID: string) {
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2)
  const authorization = "Bearer " + crypto.randomUUID()
  const messages: BrowserHostMessage[] = []
  let socket: ServerWebSocket<undefined> | undefined
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== authorization) return new Response(null, { status: 401 })
      return server.upgrade(request) ? undefined : new Response(null, { status: 404 })
    },
    websocket: {
      open(value) {
        socket = value
      },
      message(value, data) {
        const message = BrowserHostMessageSchema.parse(JSON.parse(String(data)))
        messages.push(message)
        if (message.type === "host.register") {
          expect(message.token).toBe(token)
          value.send(JSON.stringify({ type: "host.registered", protocolVersion, hostId: message.hostId }))
        }
      },
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
  })
  return {
    member: {
      connectionID,
      runtimeID: "same-remote-runtime",
      browser: { url: server.url.href, token, headers: { authorization } },
    },
    messages,
    send(message: BrowserHostMessage) {
      socket!.send(JSON.stringify(message))
    },
    async result(requestId: string) {
      await until(() => messages.some((message) => message.type === "page.result" && message.requestId === requestId))
      return messages.find((message) => message.type === "page.result" && message.requestId === requestId)
    },
  }
}

test("member Browser ownership uses the account connection and keeps colliding remote identities independent", async () => {
  const a = server("connection-a"),
    b = server("connection-b")
  const inputs: BrowserNativePageInput[] = []
  const destroyed: BrowserNativePageInput[] = []
  const nativePool = {
    async create(input: BrowserNativePageInput) {
      inputs.push(input)
      return {
        state: () => input.page,
        isAlive: () => !destroyed.includes(input),
        async destroy() {
          destroyed.push(input)
        },
        async execute() {
          return { type: "void" }
        },
      }
    },
  } as BrowserNativePagePool
  const browsers = new DesktopMemberBrowsers({ nativePool, theme: () => theme, clearSavedData: async () => {} })
  const first = await browsers.start(a.member)
  cleanups.push(() => first.close())
  const second = await browsers.start(b.member)
  cleanups.push(() => second.close())
  await until(() => a.messages.length > 0 && b.messages.length > 0)
  await expect(browsers.start(a.member)).rejects.toThrow("already")
  const contextId = crypto.randomUUID(),
    epoch = crypto.randomUUID()
  for (const host of [a, b]) {
    host.send({
      type: "profile.data.prepare",
      protocolVersion,
      requestId: "prepare",
      ownerKey,
      contextId,
      epoch,
      expiresAt: Date.now() + 60_000,
      profile: { id: "personal", partition: "persist:synergy-browser-shared", revision: 1 },
    })
    expect(await host.result("prepare")).toMatchObject({ result: { type: "void" } })
    host.send({
      type: "page.create",
      protocolVersion,
      requestId: "create",
      ownerKey,
      owner,
      routeDirectory: "/fixture",
      presentation: "native",
      page: { id: "same-page", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
      profile: { id: "personal", partition: "persist:synergy-browser-shared", revision: 1 },
      networkProxy: { server: "direct://", username: "unused", password: "unused" },
      downloadDir: "/fixture/downloads",
    })
    expect(await host.result("create")).toMatchObject({ result: { type: "page" } })
  }
  expect(inputs[0].ownerKey).not.toBe(inputs[1].ownerKey)
  expect(inputs[0].profile.partition).not.toBe(inputs[1].profile.partition)
  await first.close()
  expect(destroyed).toEqual([inputs[0]])
  b.send({
    type: "page.command",
    protocolVersion,
    requestId: "still-live",
    ownerKey,
    pageId: "same-page",
    command: { type: "stop" },
  })
  expect(await b.result("still-live")).toMatchObject({ result: { type: "void" } })
  const restarted = await browsers.start(a.member)
  cleanups.push(() => restarted.close())
  await until(() => a.messages.filter((message) => message.type === "host.register").length === 2)
  await first.close()
  expect(destroyed).toHaveLength(1)
  await second.close()
  expect(destroyed).toEqual(inputs)
})
