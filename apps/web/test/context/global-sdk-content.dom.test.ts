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
    dispose(): void
  }
}

test("the WebSocket entry preserves new Part discovery across inactive subscription generations", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".sdk-content-"))
  const entry = path.join(directory, "main.tsx")
  const stub = path.join(directory, "platform.ts")
  const globalSDK = path.resolve(import.meta.dir, "../../src/context/global-sdk.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  await Bun.write(
    stub,
    `
    export const reads = []
    export const usePlatform = () => ({fetch: async (request) => {
      if (new URL(request.url).pathname === '/global/capabilities')
        return Response.json({apiVersion:1,features:[],transports:{projection:'projection-v2'}})
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
    import { reads } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api
      const events=[]
      function Consumer(){api=useGlobalSDK();onCleanup(api.event.listen(event=>events.push(event)));return <div/>}
      const dispose=render(()=><GlobalSDKProvider><Consumer/></GlobalSDKProvider>,root)
      return {api:()=>api,events,reads,dispose}
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
  }
  const frames = new Map<number, FrameRequestCallback>()
  let frameID = 0
  let visible = true
  const waitUntil = async (predicate: () => boolean) => {
    const until = Date.now() + 2000
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
