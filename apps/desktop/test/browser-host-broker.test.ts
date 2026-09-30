import { afterEach, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  browserOwnerKey,
  type BrowserBackendCommand,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import type {
  BrowserNativePageHandle,
  BrowserNativePageInput,
  BrowserNativePagePool,
} from "../src/browser-native-page-pool"
import { DEFAULT_DESKTOP_SHELL_SKIN } from "../src/default-shell-skin.generated"
import { desktopThemeSnapshot } from "../src/theme"
import { registerElectronMock } from "./electron-mock"

registerElectronMock()
const { BrowserHostBrokerClient } = await import("../src/browser-host-broker")

const theme = desktopThemeSnapshot({ version: 2, source: "system", ...DEFAULT_DESKTOP_SHELL_SKIN }, false)
const token = "a".repeat(64)
const owner = { mode: "session" as const, scopeID: "fixture-scope", sessionID: "fixture-task", directory: null }
const ownerKey = browserOwnerKey(owner)
const protocolVersion = BROWSER_PROTOCOL_VERSION
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Broker condition timed out")
    await Bun.sleep(5)
  }
}

function create(requestId: string, pageId = requestId): BrowserHostMessage {
  return {
    type: "page.create",
    protocolVersion,
    requestId,
    ownerKey,
    owner,
    routeDirectory: "/fixture",
    presentation: "native",
    page: { id: pageId, url: "https://example.com", title: "Fixture", isLoading: false, lastActiveAt: null },
    profile: { id: "personal", partition: "persist:synergy-browser-fixture", revision: 0 },
    networkProxy: { server: "http://127.0.0.1:1", username: "fixture", password: "fixture" },
    downloadDir: "/fixture/downloads",
  }
}

function command(requestId: string, pageId: string, command: BrowserBackendCommand): BrowserHostMessage {
  return BrowserHostMessageSchema.parse({ type: "page.command", protocolVersion, requestId, ownerKey, pageId, command })
}

async function fixture() {
  const messages: BrowserHostMessage[] = []
  const inputs: BrowserNativePageInput[] = []
  const executed: Array<{ pageId: string; command: BrowserBackendCommand }> = []
  const destroyed: string[] = []
  const status: string[] = []
  let socket: ServerWebSocket<undefined> | undefined
  let beforeCreate: () => Promise<void> = async () => undefined
  let execute: (command: BrowserBackendCommand) => Promise<void> = async () => undefined
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 404 })
    },
    websocket: {
      open(value) {
        socket = value
      },
      message(value, data) {
        const message = BrowserHostMessageSchema.parse(JSON.parse(String(data)))
        messages.push(message)
        if (message.type === "host.register")
          value.send(JSON.stringify({ type: "host.registered", protocolVersion, hostId: message.hostId }))
      },
    },
  })
  const nativePool = {
    async create(input: BrowserNativePageInput): Promise<BrowserNativePageHandle> {
      inputs.push(input)
      await beforeCreate()
      return {
        state: () => input.page,
        isAlive: () => !destroyed.includes(input.page.id),
        async destroy() {
          destroyed.push(input.page.id)
        },
        async execute(command) {
          executed.push({ pageId: input.page.id, command })
          await execute(command)
          return { type: "void" }
        },
      }
    },
  } as BrowserNativePagePool
  const client = new BrowserHostBrokerClient({
    serverUrl: server.url.href,
    token,
    theme,
    nativePool,
    onStatus: (value) => status.push(value),
  })
  cleanups.push(async () => {
    await client.close()
    await server.stop(true)
  })
  client.connect()
  await until(() => status.includes("ready"))
  return {
    client,
    messages,
    inputs,
    executed,
    destroyed,
    status,
    blockCreation(value: () => Promise<void>) {
      beforeCreate = value
    },
    interceptExecution(value: typeof execute) {
      execute = value
    },
    disconnect() {
      socket!.close()
    },
    send(value: BrowserHostMessage) {
      socket!.send(JSON.stringify(value))
    },
    async result(requestId: string) {
      await until(() => messages.some((message) => message.type === "page.result" && message.requestId === requestId))
      return messages.find((message) => message.type === "page.result" && message.requestId === requestId) as Extract<
        BrowserHostMessage,
        { type: "page.result" }
      >
    },
  }
}

test("broker rejects remote or credential-bearing servers before connecting", () => {
  for (const serverUrl of ["https://example.com", "file:///tmp/browser", "http://user:secret@localhost"]) {
    expect(() => new BrowserHostBrokerClient({ serverUrl, token, theme })).toThrow("local Desktop server")
  }
  expect(() => new BrowserHostBrokerClient({ serverUrl: "http://localhost", token: "invalid", theme })).toThrow()
})

test("broker registers native capability and keeps command queues page-scoped", async () => {
  const f = await fixture()
  expect(f.messages[0]).toMatchObject({ type: "host.register", token, capabilities: { native: true } })
  for (const id of ["first", "second"]) {
    f.send(create(id))
    expect((await f.result(id)).result?.type).toBe("page")
  }
  const held = Promise.withResolvers<void>()
  f.interceptExecution(async (command) => {
    if (command.type === "reload") await held.promise
  })
  f.send(command("held", "first", { type: "reload" }))
  f.send(command("queued", "first", { type: "stop" }))
  f.send(command("independent", "second", { type: "stop" }))
  expect((await f.result("independent")).result).toEqual({ type: "void" })
  expect(f.executed.filter((entry) => entry.pageId === "first").map((entry) => entry.command.type)).toEqual(["reload"])
  held.resolve()
  await f.result("queued")
  expect(f.executed.filter((entry) => entry.pageId === "first").map((entry) => entry.command.type)).toEqual([
    "reload",
    "stop",
  ])
})

test("dialog replies unblock a pending command on the same page", async () => {
  const f = await fixture()
  f.send(create("dialog-page"))
  await f.result("dialog-page")
  const held = Promise.withResolvers<void>()
  f.interceptExecution(async (command) => {
    if (command.type === "reload") await held.promise
    if (command.type === "dialog.respond") held.resolve()
  })
  f.send(command("held", "dialog-page", { type: "reload" }))
  await until(() => f.executed.length === 1)
  f.send(command("reply", "dialog-page", { type: "dialog.respond", requestId: "dialog", accept: true }))
  expect((await f.result("reply")).result).toEqual({ type: "void" })
  expect((await f.result("held")).result).toEqual({ type: "void" })
})

test("unknown and closed pages return structured failures without executing another page", async () => {
  const f = await fixture()
  f.send(create("page"))
  await f.result("page")
  f.send({ type: "page.close", protocolVersion, requestId: "close", ownerKey, pageId: "page" })
  expect((await f.result("close")).result).toEqual({ type: "void" })
  f.send(command("missing", "page", { type: "stop" }))
  expect((await f.result("missing")).error).toMatchObject({ code: "browser_host_command_failed", retryable: false })
  expect(f.executed).toEqual([])
  expect(f.destroyed).toEqual(["page"])
})

test("a page created after disconnect is destroyed and never acknowledged", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<void>()
  f.blockCreation(() => held.promise)
  f.send(create("late"))
  await until(() => f.inputs.length === 1)
  f.disconnect()
  await until(() => f.status.includes("restarting"))
  held.resolve()
  await until(() => f.destroyed.includes("late"))
  expect(f.messages.some((message) => message.type === "page.result" && message.requestId === "late")).toBe(false)
})

test("disconnect destroys all owned pages before reconnection", async () => {
  const f = await fixture()
  for (const id of ["first", "second"]) {
    f.send(create(id))
    await f.result(id)
  }
  f.disconnect()
  await until(() => f.destroyed.length === 2)
  expect(f.destroyed.toSorted()).toEqual(["first", "second"])
  await f.client.close()
  expect(f.destroyed).toHaveLength(2)
})
