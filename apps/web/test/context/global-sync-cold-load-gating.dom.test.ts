import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"
import { produce } from "solid-js/store"
import type { ContentSummaryProperties, createContentSubscriptions } from "../../src/context/content-subscriptions"

type SnapshotVersion = { epoch: string; seq: number }
type ScopeApi = ReturnType<typeof import("../../src/context/global-sync").useGlobalSync>
type ScopeState = ReturnType<ScopeApi["ensureScopeState"]>

type Fixture = {
  mount(root: Element): {
    started: Promise<void>
    dispose(): void
    api(): ScopeApi
    emit(key: string, seq: number, type: string, properties: Record<string, unknown>, epoch?: string): void
    complete(key: string, data: Record<string, unknown>, version?: SnapshotVersion): void
    completeReplay(index: number, events: Array<Record<string, unknown>>, seq: number, epoch?: string): void
    waitForRequest(key: string): Promise<void>
    waitComplete(state: ScopeState): Promise<void>
    flushRepairs(): void
    pages: Array<{ signal: AbortSignal; resolve(value: unknown): void; trace?: string }>
    replays: Array<(value: unknown) => void>
    completePage(index: number, messageID: string): void
    content: ReturnType<typeof createContentSubscriptions>
    emitContent(key: string, properties: ContentSummaryProperties, seq?: number): void
  }
}

test("replay part events skip freshness bumps and repairs until the window is established", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".cold-gating-"))
  const entry = path.join(directory, "main.tsx")
  const stub = path.join(directory, "services.tsx")
  const globalSync = path.resolve(import.meta.dir, "../../src/context/global-sync.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  await Bun.write(
    stub,
    `
    import { createPartRepairScheduler as realScheduler } from "../../../src/context/part-repair-scheduler"
    import { createContentSubscriptions, projectContentSummary } from "../../../src/context/content-subscriptions"
    export const content = createContentSubscriptions(() => {})
    export const emitContent = (key, properties, seq) => {
      const projected = projectContentSummary(content, key, properties, seq)
      if (projected) emit(key, seq, "message.part.summary", projected)
    }
    const timers = new Set()
    export const flushRepairs = () => { const pending = [...timers]; timers.clear(); for (const fn of pending) fn() }
    export const pages = []
    export const repairCalls = []
    export const createPartRepairScheduler = (options, repair) => realScheduler({ ...options, schedule: (fn, _delay) => { timers.add(fn); return () => timers.delete(fn) } }, (scopeKey, sessionID) => { repairCalls.push([scopeKey, sessionID, JSON.stringify([scopeKey, sessionID])]); repair(scopeKey, sessionID) })
    export const requests = []
    export const replays = []
    let listener
    export const emit = (key, seq, type, properties, epoch) => listener({name:key,details:{type,epoch:epoch??"epoch-a",seq,properties}})
    const ok = data => Promise.resolve({data})
    export function createSynergyClient(options) {
      return {
        scope: { bootstrapCore: () => (options.scopeID === "home" || options.scopeID.startsWith("background.")) ? ok({scopeID:options.scopeID,provider:{all:[]},agent:[],config:{}}) : new Promise(resolve => requests.push({key:options.scopeID,resolve,done:false})) },
        permission: {list:()=>ok([])}, question: {list:()=>ok([])},
        event:{replay:()=>new Promise(resolve=>replays.push(resolve))},
        session:{list:()=>ok({total:0,data:[]}),inbox:()=>ok([]),timelinePage:(_input, options)=>new Promise(resolve=>pages.push({resolve,signal:options.signal,trace:new Error("timelinePage").stack}))},
      }
    }
    export const useGlobalSDK = () => ({capabilities:{load:async()=>{},has:()=>true},prepareScopeState(){},connected:()=>false,content:{active(){}},event:{listen:fn=>{listener=fn;return()=>{listener=undefined}}},url:'http://localhost/',client:{
      config:{global:()=>ok({})},global:{health:()=>ok({healthy:true}),paths:{get:()=>ok({})},agenda:{list:()=>ok([])}},
      scope:{list:()=>ok([])},provider:{list:()=>ok({all:[]}),auth:()=>ok({})},session:{statuses:()=>ok({})},
    }})
    export const LocaleConfigReconciler=()=>null
    export const FatalErrorPage=()=> <div>failure</div>
    export const DialogSelectServer=()=>null
    export const useDialog=()=>({show(){}})
    export const showToast=()=>{}
    export const browserPerformanceEnabled=()=>false
    export const startBrowserPerformanceMetrics=()=>{}
    export const stopBrowserPerformanceMetrics=()=>{}
    export const browserTokenDurationSampleRate=()=>0.1
    export const recordTokenApply=()=>{}
  `,
  )
  await Bun.write(
    entry,
    `
    import { render } from "solid-js/web"
    import { createRoot, createComputed } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { GlobalSyncProvider, useGlobalSync } from ${JSON.stringify(globalSync)}
    import { requests, emit, pages, flushRepairs, content, emitContent, replays, repairCalls } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api, ready
      const started = new Promise(resolve=>ready=resolve)
      function Child(){api=useGlobalSync();ready();return <div>ready</div>}
      const dispose=render(()=><I18nProvider i18n={setupI18n({locale:'en',messages:{en:{}}})}><GlobalSyncProvider><Child/></GlobalSyncProvider></I18nProvider>,root)
      return {started,dispose,emit,pages,flushRepairs,content,emitContent,api:()=>api,replays,repairCalls,
        completeReplay(index, events, seq, epoch) {
          const resolve=replays[index]
          if (!resolve) throw new Error("no pending replay "+index)
          resolve({data:{status:"ok",epoch:epoch??"epoch-a",seq,events}})
        },
        completePage(index, messageID) { pages[index].resolve({data:{items:[{info:{id:messageID,sessionID:"scope-session",role:"user",time:{created:2}},parts:[]}],referencedRoots:[],nextCursor:null,hasMore:false,total:1}}) },
        complete(key,data,version) {
          const request=requests.find(r=>!r.done&&r.key===key)
          if(!request) throw new Error("no pending bootstrap for "+key)
          request.done=true
          const headers=version?{get:name=>name==="x-synergy-seq"?String(version.seq):name==="x-synergy-epoch"?version.epoch:undefined}:undefined
          request.resolve({data,response:headers?{headers}:undefined})
        },
        waitForRequest(key) {return new Promise((resolve,reject)=>{const until=Date.now()+2000;const check=()=>{if(requests.some(r=>!r.done&&r.key===key))return resolve();if(Date.now()>until)return reject(new Error("no bootstrap request: "+key));setTimeout(check,5)};check()})},
        waitComplete(state) {return new Promise((resolve,reject)=>createRoot(dispose=>{const timer=setTimeout(()=>{dispose();reject(new Error('bootstrap incomplete: '+state[0].status))},2000);createComputed(()=>{if(state[0].status==='complete'){clearTimeout(timer);dispose();resolve()}})}))},
      }
    }
  `,
  )
  try {
    const stubbed = [
      "./global-sdk",
      "./part-repair-scheduler",
      "./locale-config-reconciler",
      "../pages/fatal-error",
      "@/components/dialog/dialog-select-server",
      "@/components/performance/browser-metrics",
      "@ericsanchezok/synergy-sdk/client",
      "@ericsanchezok/synergy-ui/toast",
      "@ericsanchezok/synergy-ui/context/dialog",
    ]
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }] },
      plugins: [
        {
          name: "scope-services",
          enforce: "pre",
          resolveId(source, importer) {
            if (
              importer === globalSync &&
              (stubbed.includes(source) ||
                stubbed.some(
                  (item) =>
                    item.startsWith("@/") && source === path.resolve(import.meta.dir, "../../src", item.slice(2)),
                ))
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
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as Fixture
    const h = fixture.mount(root)
    try {
      await h.started
      const api = h.api()

      const retained = api.retainScopeState("cold")
      await h.waitForRequest("cold")
      h.complete(
        "cold",
        { scopeID: "scope-cold", provider: { all: [] }, agent: [], config: {} },
        { epoch: "epoch-a", seq: 1 },
      )
      await h.waitComplete(retained.state)
      const [state, setState] = retained.state

      const sessionID = "cold-session"
      const user = (owner: string, id: string, created = 1) =>
        ({ id, sessionID: owner, role: "user", time: { created } }) as (typeof state.message)[string][number]
      const textPart = (owner: string, id: string, messageID: string) =>
        ({ id, sessionID: owner, messageID, type: "text", text: "body" }) as (typeof state.part)[string][number]
      const summary = {
        id: "s1",
        messageID: "m1",
        sessionID,
        type: "text",
        preview: "",
        render: true,
        content: { version: "v1", bytes: 5 },
      }
      const tick = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      // A message bucket whose session has no message window yet: the state
      // cold load lives in while the first timeline page is in flight.
      const seedBare = () => {
        setState("message", sessionID, [user(sessionID, "old"), user(sessionID, "m1", 2)])
        setState("part", "m1", [textPart(sessionID, "p1", "m1")] as (typeof state.part)[string])
      }
      const seedWindow = () => {
        setState("messageWindow", sessionID, {
          nextCursor: null,
          hasMore: false,
          total: 2,
          mode: "latest",
          pendingLatest: false,
          pendingLatestIds: [],
          tailMissingLatest: false,
        })
      }
      // An epoch change deterministically routes through replayOrResync; a
      // same-epoch seq jump can land while the watermark races bootstrap and
      // is read as first-establish instead of a gap.
      const changeEpoch = async (epoch: string) => {
        h.emit("cold", 2, "fixture.tick", {}, epoch)
        await tick()
      }

      // Phase 1: replayed part events on a window-less bucket produce no
      // freshness bump and no repair request.
      seedBare()
      const request = api.capturePartSnapshotRequest("cold", sessionID)
      await changeEpoch("epoch-b")
      expect(h.replays, "first epoch change must request one replay").toHaveLength(1)
      h.completeReplay(
        0,
        [
          { type: "message.part.summary", properties: { summary } },
          {
            type: "message.part.delta",
            properties: { sessionID, messageID: "m1", partID: "p1", kind: "text", delta: "!" },
          },
          { type: "message.part.updated", properties: { part: textPart(sessionID, "p2", "m1") } },
          { type: "message.part.removed", properties: { sessionID, messageID: "m1", partID: "p1" } },
        ],
        10,
        "epoch-b",
      )
      await tick()
      expect(api.partSnapshotAction("cold", sessionID, "m1", request), "replay must not bump freshness").toBe("apply")
      h.flushRepairs()
      await tick()
      expect(h.pages, "replay must not schedule a window repair").toHaveLength(0)

      // Phase 2: the same event delivered live invalidates immediately.
      h.emit("cold", 11, "message.part.updated", { part: textPart(sessionID, "p3", "m1") }, "epoch-b")
      await tick()
      expect(api.partSnapshotAction("cold", sessionID, "m1", request), "live events keep full gating").toBe("retry")

      // Phase 3: replay on an established window keeps live semantics.
      seedWindow()
      const windowed = api.capturePartSnapshotRequest("cold", sessionID)
      await changeEpoch("epoch-c")
      expect(h.replays, "second epoch change must request a second replay").toHaveLength(2)
      h.completeReplay(
        1,
        [{ type: "message.part.updated", properties: { part: textPart(sessionID, "p4", "m1") } }],
        20,
        "epoch-c",
      )
      await tick()
      expect(api.partSnapshotAction("cold", sessionID, "m1", windowed), "replay on a loaded window keeps touches").toBe(
        "preserve",
      )

      // Phase 4: a repair scheduled while the window vanishes defers and
      // fires once the window exists again.
      const repairSession = "repair-session"
      const seedRepair = () => {
        setState("message", repairSession, [user(repairSession, "windowed")])
        setState("messageWindow", repairSession, {
          nextCursor: null,
          hasMore: false,
          total: 1,
          mode: "latest",
          pendingLatest: false,
          pendingLatestIds: [],
          tailMissingLatest: false,
        })
      }
      seedRepair()
      h.emit(
        "cold",
        21,
        "message.part.updated",
        {
          part: { id: "ghost", sessionID: repairSession, messageID: "ghost", type: "text", text: "dropped" },
        },
        "epoch-c",
      )
      await tick()
      expect(h.pages, "a dropped out-of-window checkpoint alone fetches nothing").toHaveLength(0)
      setState("message", repairSession, undefined as never)
      setState("messageWindow", repairSession, undefined as never)
      expect(state.message[repairSession], "window delete must land in the store").toBeUndefined()
      expect(state.messageWindow[repairSession], "window delete must land in the store").toBeUndefined()
      h.flushRepairs()
      await tick()
      if (h.pages.length) console.error("[debug] page trace:", h.pages[0]?.trace?.split("\n").slice(0, 12).join("\n"))
      expect(h.pages, "repair must defer while the window is missing").toHaveLength(0)
      seedRepair()
      h.flushRepairs()
      await tick()
      expect(h.pages, "the deferred repair fires once the window exists").toHaveLength(1)
      retained.release()
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
