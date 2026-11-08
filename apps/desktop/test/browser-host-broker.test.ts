import { afterEach, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
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
import { BrowserDataContexts } from "../src/browser-data-contexts"
import type { BrowserHostBrokerOptions } from "../src/browser-host-broker"
import { electronMock, registerElectronMock } from "./electron-mock"

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

async function fixture(options: Pick<BrowserHostBrokerOptions, "runtimeKey" | "dataContexts" | "clearSavedData"> = {}) {
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
    ...options,
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

test("member brokers isolate native owners and partitions while preserving canonical wire identity", async () => {
  const personal = await fixture()
  const one = await fixture({ runtimeKey: "member-one" })
  const two = await fixture({ runtimeKey: "member-two" })
  for (const f of [personal, one, two]) {
    f.send(create("shared-page"))
    expect((await f.result("shared-page")).result?.type).toBe("page")
  }
  const inputs = [personal, one, two].map((f) => f.inputs[0])
  expect(new Set(inputs.map((input) => input.ownerKey)).size).toBe(3)
  expect(new Set(inputs.map((input) => input.profile.partition)).size).toBe(3)
  expect(personal.inputs[0].ownerKey).toBe(ownerKey)
  expect(personal.inputs[0].profile.partition).toBe("persist:synergy-browser-fixture")
  const event = { type: "page.closed" as const, pageId: "shared-page" }
  one.inputs[0].emit(event)
  await until(() => one.messages.some((message) => message.type === "page.event"))
  expect(one.messages.find((message) => message.type === "page.event")).toMatchObject({ ownerKey, event })
  await one.client.close()
  expect(two.destroyed).toEqual([])
  two.send(command("still-live", "shared-page", { type: "stop" }))
  expect((await two.result("still-live")).result).toEqual({ type: "void" })
})

test("member profile contexts and clearing stay within the broker's native partition", async () => {
  const cleared: string[] = []
  const saved: string[] = []
  const profileSession = (partition: string) => ({
    clearStorageData: async () => {
      cleared.push(partition)
    },
    clearCache: async () => {},
    clearAuthCache: async () => {},
    closeAllConnections: async () => {},
  })
  const previous = Reflect.get(electronMock.session, "fromPartition")
  Reflect.set(electronMock.session, "fromPartition", profileSession)
  cleanups.push(async () => {
    if (previous === undefined) Reflect.deleteProperty(electronMock.session, "fromPartition")
    else Reflect.set(electronMock.session, "fromPartition", previous)
  })
  const a = new BrowserDataContexts({ session: (partition) => profileSession(partition) as never })
  const b = new BrowserDataContexts({ session: (partition) => profileSession(partition) as never })
  const first = await fixture({
    runtimeKey: "member-one",
    dataContexts: a,
    clearSavedData: async (partition) => {
      saved.push(partition)
    },
  })
  const second = await fixture({ runtimeKey: "member-two", dataContexts: b })
  const contextId = crypto.randomUUID()
  const epoch = crypto.randomUUID()
  const profile = { id: "personal", partition: "persist:synergy-browser-fixture", revision: 0 }
  for (const f of [first, second]) {
    f.send({
      type: "profile.data.prepare",
      protocolVersion,
      requestId: "prepare",
      contextId,
      epoch,
      ownerKey,
      expiresAt: Date.now() + 60_000,
      profile,
    })
    expect((await f.result("prepare")).result).toEqual({ type: "void" })
  }
  const own = a.target(contextId)
  const other = b.target(contextId)
  expect(own.partition).not.toBe(other.partition)
  expect(own.partition).not.toBe(profile.partition)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const writing = own.write(async () => {
    entered.resolve()
    await release.promise
  })
  try {
    await entered.promise
    first.send({
      type: "profile.clear",
      protocolVersion,
      requestId: "clear",
      profileId: profile.id,
      partition: profile.partition,
      removeSavedData: true,
    })
    await until(() => own.signal.aborted)
    expect(cleared).toEqual([])
    release.resolve()
    expect((await first.result("clear")).result).toEqual({ type: "void" })
    expect(cleared).toEqual([own.partition])
    expect(saved).toEqual([own.partition])
    expect(other.current()).toBe(true)
    second.send({ type: "profile.data.release", protocolVersion, requestId: "release", contextId, epoch, ownerKey })
    expect((await second.result("release")).result).toEqual({ type: "void" })
    expect(other.current()).toBe(false)
  } finally {
    release.resolve()
    await writing
    a.disconnect()
    b.disconnect()
  }
})

test("Node WebSocket closes incompatible or wrong-role broker messages without unhandled rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synergy-broker-close-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const built = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../src/browser-host-broker.ts")],
    outdir: root,
    target: "node",
    format: "esm",
    naming: "broker.mjs",
    plugins: [
      {
        name: "electron-session-fixture",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }))
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const session = {}",
            loader: "js",
          }))
        },
      },
    ],
  })
  expect(built.success).toBe(true)
  const script = `import { BrowserHostBrokerClient } from ${JSON.stringify(new URL("broker.mjs", `file://${root}/`).href)};
    const timeout=setTimeout(()=>{console.error("Close was not observed");process.exit(2)},3000);
    const client=new BrowserHostBrokerClient({serverUrl:process.argv[1],token:"a".repeat(64),theme:{},onStatus(status){if(status==="restarting"){clearTimeout(timeout);void client.close().then(()=>process.exit(0))}}});client.connect();`
  for (const payload of [
    JSON.stringify({ type: "host.registered", protocolVersion: 6, hostId: "old-host" }),
    JSON.stringify({ type: "page.result", protocolVersion, requestId: "wrong-role", result: { type: "void" } }),
  ]) {
    let closeCode = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 404 })
      },
      websocket: {
        message(socket) {
          socket.send(payload)
        },
        close(_socket, code) {
          closeCode = code
        },
      },
    })
    try {
      const child = Bun.spawn(["node", "--input-type=module", "--eval", script, server.url.href], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      expect(closeCode).toBe(payload.includes("old-host") ? 4003 : 4008)
    } finally {
      await server.stop(true)
    }
  }
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
  f.send(command("queued", "first", { type: "setViewport", width: 800, height: 600 }))
  f.send(command("independent", "second", { type: "stop" }))
  expect((await f.result("independent")).result).toEqual({ type: "void" })
  expect(f.executed.filter((entry) => entry.pageId === "first").map((entry) => entry.command.type)).toEqual(["reload"])
  held.resolve()
  await f.result("queued")
  expect(f.executed.filter((entry) => entry.pageId === "first").map((entry) => entry.command.type)).toEqual([
    "reload",
    "setViewport",
  ])
})

test("stop and close remain available while an Agent command is waiting", async () => {
  const f = await fixture()
  f.send(create("slow-page"))
  await f.result("slow-page")
  const held = Promise.withResolvers<void>()
  f.interceptExecution(async (command) => {
    if (command.type === "reload") await held.promise
  })
  f.send(command("held", "slow-page", { type: "reload" }))
  await until(() => f.executed.length === 1)
  f.send(command("stop", "slow-page", { type: "stop" }))
  expect((await f.result("stop")).result).toEqual({ type: "void" })
  f.send({ type: "page.close", protocolVersion, requestId: "close", ownerKey, pageId: "slow-page" })
  expect((await f.result("close")).result).toEqual({ type: "void" })
  held.resolve()
  await f.result("held")
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
