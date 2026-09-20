import { expect, test } from "bun:test"
import { ProductRuntimeHandle } from "../../src/server/runtime-handle"
import { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ObservabilityContext } from "@ericsanchezok/synergy-harness/observability/context"

test("full and core compositions coexist and closing full leaves core usable", async () => {
  await using a = await runtimeHome()
  await using b = await runtimeHome()
  await using core = await openLocalRuntime({ host: a.host, mode: "oneshot" })
  await using product = await ProductRuntimeHandle.openTask({ host: b.host, mode: "oneshot" })
  expect(core.run(() => MigrationRegistry.list().has("library"))).toBe(false)
  expect(product.run(() => MigrationRegistry.list().has("library"))).toBe(true)
  const scoped = <T>(runtime: typeof core, fn: () => T) =>
    runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
  const coreTools = await scoped(core, () => ToolRegistry.ids())
  const productTools = await scoped(product, () => ToolRegistry.ids())
  expect(coreTools).not.toContain("note_write")
  expect(productTools).toContain("note_write")
  await product.close()
  const session = await scoped(core, () => Session.create({ title: "Core remains ready" }))
  expect((await scoped(core, () => Session.get(session.id))).title).toBe("Core remains ready")
}, 30_000)

test("two HTTP runtimes keep session routes, configuration, CORS and Library vectors independent", async () => {
  const { LibraryDB } = await import("@ericsanchezok/synergy-library/database")
  const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
  await using a = await runtimeHome()
  await using b = await runtimeHome()
  const aHost = {
    ...a.host,
    env: { ...a.host.env, SYNERGY_CONFIG_CONTENT: JSON.stringify({ model: "openai/model-a" }) },
  }
  const bHost = {
    ...b.host,
    env: { ...b.host.env, SYNERGY_CONFIG_CONTENT: JSON.stringify({ model: "openai/model-b" }) },
  }
  await using left = await ProductRuntimeHandle.open({
    host: aHost,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0, cors: ["https://a.example"] },
  })
  await using right = await ProductRuntimeHandle.open({
    host: bHost,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0, cors: ["https://b.example"] },
  })
  const scoped = <T>(runtime: typeof left, fn: () => T) =>
    runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
  const id = Identifier.ascending("session")
  await scoped(left, () => Session.create({ id, title: "Left" }))
  await scoped(right, () => Session.create({ id, title: "Right" }))
  const url = (runtime: typeof left, route: string) => `http://127.0.0.1:${runtime.server.port}${route}?scopeID=home`
  const request = (runtime: typeof left) =>
    fetch(url(runtime, `/session/${id}`), { headers: { Origin: "https://a.example" } })
  const [aResponse, bResponse] = await Promise.all([request(left), request(right)])
  expect(aResponse.status).toBe(200)
  expect(bResponse.status).toBe(200)
  expect((await aResponse.json()).title).toBe("Left")
  expect((await bResponse.json()).title).toBe("Right")
  expect(aResponse.headers.get("access-control-allow-origin")).toBe("https://a.example")
  expect(bResponse.headers.get("access-control-allow-origin")).toBeNull()
  expect((await (await fetch(url(left, "/config"))).json()).model).toBe("openai/model-a")
  expect((await (await fetch(url(right, "/config"))).json()).model).toBe("openai/model-b")
  const memory = {
    id: "same-memory",
    title: "Isolated",
    content: "Remember the owner",
    category: "general" as const,
    recallMode: "contextual" as const,
  }
  left.run(() => LibraryDB.Memory.insert(memory, { id: "a", model: "a", vector: [1, 0] }))
  right.run(() => LibraryDB.Memory.insert({ ...memory, title: "Right" }, { id: "b", model: "b", vector: [1, 0, 0] }))
  expect(left.run(() => LibraryDB.vecHealth().memory.dimensions)).toBe(2)
  expect(right.run(() => LibraryDB.vecHealth().memory.dimensions)).toBe(3)
  await left.close()
  expect((await (await request(right)).json()).title).toBe("Right")
  expect(right.run(() => LibraryDB.Memory.get(memory.id)?.title)).toBe("Right")
  expect(right.run(() => LibraryDB.isMemoryVecReady())).toBe(true)
}, 30_000)

test("WebSocket envelopes identify Scope ownership and keep the other Runtime connected during shutdown", async () => {
  const { GlobalBus } = await import("@ericsanchezok/synergy-harness/bus/global")
  await using a = await runtimeHome()
  await using b = await runtimeHome()
  await using left = await ProductRuntimeHandle.open({
    host: a.host,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0 },
  })
  await using right = await ProductRuntimeHandle.open({
    host: b.host,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0 },
  })
  const connect = async (port: number) => {
    const ClientSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket }
    const socket = new ClientSocket(`ws://127.0.0.1:${port}/global/event/ws?stream=delta`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    type Frame = { scopeID: string | null; payload: { type: string; properties: Record<string, unknown> } }
    const frames: Frame[] = []
    const listeners = new Set<() => void>()
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)))
      for (const listener of listeners) listener()
    })
    async function next(type: string) {
      const read = () => frames.find((frame) => frame.payload.type === type)
      if (read()) return read()!
      const result = Promise.withResolvers<Frame>()
      const receive = () => {
        const frame = read()
        if (frame) result.resolve(frame)
      }
      listeners.add(receive)
      const timeout = setTimeout(() => result.reject(new Error(`Missing ${type}`)), 3000)
      try {
        return await result.promise
      } finally {
        clearTimeout(timeout)
        listeners.delete(receive)
      }
    }
    await next("server.connected")
    return {
      next,
      socket,
      [Symbol.dispose]() {
        socket.close()
      },
    }
  }
  using aSocket = await connect(left.server.port!)
  using bSocket = await connect(right.server.port!)
  expect((await aSocket.next("server.connected")).scopeID).toBeNull()
  const scope = left.run(() => Scope.home())
  await left.run(() => ScopeContext.provide({ scope, fn: () => Session.create({ title: "From A" }) }))
  expect((await aSocket.next("session.updated")).scopeID).toBe("home")
  await left.close()
  expect(bSocket.socket.readyState).toBe(WebSocket.OPEN)
  right.run(() =>
    GlobalBus().emit("event", {
      scopeID: null,
      payload: { type: "runtime.reloaded", properties: { executed: [], cascaded: [], changedFields: [] } },
    }),
  )
  expect((await bSocket.next("runtime.reloaded")).scopeID).toBeNull()
  for (const route of ["/path", "/scope/bootstrap"]) {
    const response = await fetch(`http://127.0.0.1:${right.server.port}${route}?scopeID=home`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect((route === "/path" ? body : body.path).directory).toBeNull()
  }
}, 30_000)

test("Home Browser descriptors and navigation policy do not require a filesystem workspace", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await ProductRuntimeHandle.open({
    host: fixture.host,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0 },
  })
  const session = await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create() }))
  const response = await fetch(
    `http://127.0.0.1:${runtime.server.port}/home/browser/session?scopeID=home&sessionID=${session.id}&presentation=webrtc`,
  )
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.ownerKey).toContain("home")
  expect(body.page).toBeNull()
  expect(body.status).toBe("empty")
}, 30_000)

test("closing HTTP runtimes releases their application and configuration", async () => {
  async function cycle() {
    await using fixture = await runtimeHome()
    await using runtime = await ProductRuntimeHandle.open({
      host: fixture.host,
      mode: "oneshot",
      network: { hostname: "127.0.0.1", port: 0 },
    })
    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    const owner = runtime.run(RuntimeContext.current)
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: () => ObservabilityContext.withContextAsync({ module: "server" }, () => runtime.close()),
      }),
    )
    return [new WeakRef(runtime.config), new WeakRef(owner)]
  }
  const references = [await cycle(), await cycle(), await cycle()].flat()
  let remaining = references.length
  for (let attempt = 0; attempt < 30 && remaining; attempt++) {
    await Bun.sleep(20)
    Bun.gc(true)
    remaining = references.filter((reference) => reference.deref()).length
  }
  expect(remaining).toBe(0)
}, 30_000)
