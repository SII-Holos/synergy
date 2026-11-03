import { expect, test } from "bun:test"
import type { Event } from "@ericsanchezok/synergy-sdk"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type SDK = ReturnType<typeof import("../../src/context/global-sdk").useGlobalSDK>
type SummaryEvent = Extract<Event, { type: "message.part.summary" }>
type Fixture = {
  mount(root: Element): {
    api(): SDK
    events: Array<{ name: string; details: Event }>
    reads: Array<{ signal: AbortSignal; resolve(value: Response): void }>
    capabilityReads: Array<{ signal: AbortSignal; resolve(value: Response): void }>
    holdCapabilities(): void
    dispose(): void
  }
}

test("the WebSocket entry preserves Part discovery and revalidates live capabilities across epochs", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".sdk-content-"))
  const entry = path.join(directory, "main.tsx")
  const stub = path.join(directory, "platform.ts")
  const globalSDK = path.resolve(import.meta.dir, "../../src/context/global-sdk.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  await Bun.write(
    stub,
    `
    export const reads = [], capabilityReads = []
    let held = false
    export const holdCapabilities = () => { held = true }
    export const usePlatform = () => ({fetch: async (request) => {
      if (new URL(request.url).pathname === '/global/capabilities')
        return held ? new Promise(resolve=>capabilityReads.push({signal:request.signal,resolve})) : Response.json({apiVersion:1,features:[],transports:{projection:'projection-v2'}})
      return new Promise(resolve=>reads.push({signal:request.signal,resolve}))
    }})
    export const useServer = () => ({url:'http://fixture.local',scopes:{prepare(){}}})
    export const recordTokenReceive = () => {}
    export const recordFrontendWork = () => {}
    export const stopBrowserPerformanceMetrics = () => {}
  `,
  )
  await Bun.write(
    entry,
    `
    import { render } from 'solid-js/web'
    import { onCleanup } from 'solid-js'
    import { GlobalSDKProvider, useGlobalSDK } from ${JSON.stringify(globalSDK)}
    import { reads, capabilityReads, holdCapabilities } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api
      const events=[]
      function Consumer(){api=useGlobalSDK();onCleanup(api.event.listen(event=>events.push(event)));return <div/>}
      const dispose=render(()=><GlobalSDKProvider><Consumer/></GlobalSDKProvider>,root)
      return {api:()=>api,events,reads,capabilityReads,holdCapabilities,dispose}
    }
  `,
  )
  const descriptors = {
    WebSocket: Object.getOwnPropertyDescriptor(globalThis, "WebSocket"),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
    visibilityState: Object.getOwnPropertyDescriptor(document, "visibilityState"),
  }
  const sockets: Socket[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen?: () => void
    onclose?: () => void
    onmessage?: (event: { data: string }) => void
    frames: unknown[] = []
    constructor() {
      sockets.push(this)
      queueMicrotask(() => this.onopen?.())
    }
    send(frame: string) {
      this.frames.push(JSON.parse(frame))
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
    receive(properties: SummaryEvent["properties"]) {
      this.onmessage?.({
        data: JSON.stringify({ scopeID: "scope", payload: { type: "message.part.summary", properties } }),
      })
    }
    notify(payload: Event) {
      this.onmessage?.({ data: JSON.stringify({ scopeID: null, payload }) })
    }
  }
  const frames = new Map<number, FrameRequestCallback>()
  let frameID = 0
  let visible = true
  const waitUntil = async (predicate: () => boolean, timeout = 2000) => {
    const until = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > until) throw new Error("WebSocket event did not converge")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }] },
      plugins: [
        {
          name: "transport-platform",
          enforce: "pre",
          resolveId(source, importer) {
            if (
              importer === globalSDK &&
              (source === "./platform" || source === "./server" || source.endsWith("/performance/browser-metrics"))
            )
              return stub
          },
        },
        solidPlugin(),
      ],
      build: {
        outDir: path.join(directory, "dist"),
        minify: false,
        lib: { entry, formats: ["es"], fileName: "fixture" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket })
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.set(++frameID, callback)
        return frameID
      },
    })
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => frames.delete(id),
    })
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (visible ? "visible" : "hidden"),
    })
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as Fixture
    const h = fixture.mount(root)
    try {
      await waitUntil(() => h.api().connected())
      const api = h.api()
      const socket = sockets[0]
      api.content.active("scope", "session")
      const subscription = api.content.current().active!.generation
      const part = {
        id: "final",
        messageID: "assistant",
        sessionID: "session",
        type: "text" as const,
        text: "Completed answer",
      }
      const { text, ...identity } = part
      const summary = { ...identity, render: true, preview: text, content: { version: "complete", bytes: text.length } }
      const checkpoint: SummaryEvent["properties"] = { summary, subscription, content: { kind: "checkpoint", part } }
      api.content.active("scope", "other-session")
      socket.receive(checkpoint)
      await waitUntil(() => h.events.length > 0)
      expect(h.events.at(-1)).toMatchObject({
        name: "scope",
        details: { type: "message.part.summary", properties: { summary, discovery: true } },
      })
      expect(h.events.at(-1)?.details.properties).not.toHaveProperty("content")

      api.content.active("scope", "session")
      const current = api.content.current().active!.generation
      visible = false
      window.dispatchEvent(new Event("visibilitychange"))
      socket.receive({ ...checkpoint, summary: { ...summary, id: "hidden-final" }, subscription: current })
      visible = true
      window.dispatchEvent(new Event("visibilitychange"))
      await waitUntil(() => h.events.length === 2)
      expect(h.events.at(-1)?.details.properties).toMatchObject({ summary: { id: "hidden-final" }, discovery: true })
      expect(h.events.at(-1)?.details.properties).not.toHaveProperty("content")

      socket.receive({
        ...checkpoint,
        summary: { ...summary, id: "large-final" },
        content: { kind: "reference", checkpoint: "00000000-0000-4000-8000-000000000000" },
      })
      await waitUntil(() => h.events.length === 3)
      expect(h.events.at(-1)?.details.properties).toMatchObject({ summary: { id: "large-final" }, discovery: true })
      expect(h.reads).toHaveLength(0)
      const accepted = { ...checkpoint, subscription: api.content.current().active!.generation }
      socket.receive(accepted)
      await waitUntil(() => h.events.length === 4)
      expect(h.events.at(-1)?.details.properties).toEqual(accepted)

      socket.receive({
        ...checkpoint,
        content: { kind: "append", streamID: "stale", revision: 1, offset: 0, delta: "stale text" },
      })
      socket.receive({
        ...checkpoint,
        content: { kind: "anchor", streamID: "stale", revision: 2, offset: 10, part: identity },
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.events).toHaveLength(4)

      const heldSummary = { ...summary, id: "held-final" }
      socket.receive({
        ...accepted,
        summary: heldSummary,
        content: { kind: "reference", checkpoint: "00000000-0000-4000-8000-000000000001" },
      })
      await waitUntil(() => h.reads.length === 1)
      api.content.active("scope", "other-session")
      await waitUntil(() => h.events.length === 5)
      expect(h.events.at(-1)?.details.properties).toEqual({ summary: heldSummary, discovery: true })
      expect(h.reads[0].signal.aborted).toBe(true)
      h.reads[0].resolve(Response.json({ part: { ...part, id: heldSummary.id }, version: "complete" }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.events).toHaveLength(5)

      const release = api.content.retain("scope", summary, true)
      const renewed = api.content.current().parts[0].generation
      expect(api.content.pending("scope", "session")).toBe(true)
      socket.receive({ ...checkpoint, subscription: renewed })
      expect(api.content.pending("scope", "session")).toBe(true)
      await waitUntil(() => !api.content.pending("scope", "session"))
      expect(h.events.at(-1)?.details.properties).toEqual({ ...checkpoint, subscription: renewed })
      expect(h.reads).toHaveLength(1)
      release()

      h.holdCapabilities()
      socket.notify({ type: "config.updated", properties: { scope: "global", changedFields: ["theme"] } })
      expect(h.capabilityReads).toHaveLength(0)
      socket.notify({ type: "config.updated", properties: { scope: "global", changedFields: ["features"] } })
      await waitUntil(() => h.capabilityReads.length === 1)
      expect(api.capabilities.current()).toBeUndefined()
      const enabled = { apiVersion: 1, features: ["session-long-term-memory"] }
      h.capabilityReads[0].resolve(Response.json(enabled))
      await waitUntil(() => api.capabilities.has("session-long-term-memory"))

      const reloaded: Event = {
        type: "runtime.reloaded",
        properties: { executed: ["config"], cascaded: [], changedFields: ["features"] },
      }
      socket.notify(reloaded)
      await waitUntil(() => h.capabilityReads.length === 2)
      expect(api.capabilities.has("session-long-term-memory")).toBe(false)
      socket.notify(reloaded)
      await waitUntil(() => h.capabilityReads.length === 3)
      expect(h.capabilityReads[1].signal.aborted).toBe(true)
      h.capabilityReads[2].resolve(Response.json({ apiVersion: 1, features: [] }))
      await waitUntil(() => api.capabilities.current() !== undefined)
      h.capabilityReads[1].resolve(Response.json(enabled))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(api.capabilities.has("session-long-term-memory")).toBe(false)
      expect(h.capabilityReads).toHaveLength(3)

      socket.notify(reloaded)
      await waitUntil(() => h.capabilityReads.length === 4)
      h.capabilityReads[3].resolve(Response.json({ error: "Transient discovery failure" }, { status: 500 }))
      await waitUntil(() => socket.readyState === 3 && !api.connected())
      await waitUntil(() => h.capabilityReads.length === 5)
      expect(api.capabilities.current()).toBeUndefined()
      h.capabilityReads[4].resolve(Response.json({ error: "Discovery still recovering" }, { status: 500 }))
      await waitUntil(() => h.capabilityReads.length === 6, 4000)
      expect(sockets).toHaveLength(1)
      expect(api.connected()).toBe(false)
      h.capabilityReads[5].resolve(Response.json(enabled))
      await waitUntil(() => sockets.length === 2 && api.connected())
      expect(api.capabilities.has("session-long-term-memory")).toBe(true)
      const recovered = sockets[1]
      recovered.notify(reloaded)
      await waitUntil(() => h.capabilityReads.length === 7)
      recovered.close()
      expect(h.capabilityReads[6].signal.aborted).toBe(true)
      h.capabilityReads[6].resolve(Response.json(enabled))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(api.capabilities.current()).toBeUndefined()
      expect(h.capabilityReads).toHaveLength(7)
    } finally {
      h.dispose()
    }
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const target = key === "visibilityState" ? document : globalThis
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else Reflect.deleteProperty(target, key)
    }
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
