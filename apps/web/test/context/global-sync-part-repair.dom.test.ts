import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type SnapshotVersion = { epoch: string; seq: number }
type ScopeApi = ReturnType<typeof import("../../src/context/global-sync").useGlobalSync>
type ScopeState = ReturnType<ScopeApi["ensureScopeState"]>

type Fixture = {
  mount(root: Element): {
    started: Promise<void>
    dispose(): void
    api(): ScopeApi
    emit(key: string, seq: number, type: string, properties: Record<string, unknown>): void
    complete(key: string, data: Record<string, unknown>, version?: SnapshotVersion): void
    waitForRequest(key: string): Promise<void>
    waitComplete(state: ScopeState): Promise<void>
    watchPeek(key: string, sink: (state: ScopeState | undefined) => void): () => void
    flushRepairs(): void
    pages: Array<{ signal: AbortSignal; resolve(value: unknown): void }>
    completePage(index: number, messageID: string): void
  }
}

test("part repair preserves history, diffs, and compaction ownership", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".part-repair-race-"))
  const entry = path.join(directory, "main.tsx")
  const stub = path.join(directory, "services.tsx")
  const globalSync = path.resolve(import.meta.dir, "../../src/context/global-sync.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  await Bun.write(
    stub,
    `
    import { createPartRepairScheduler as realScheduler } from "../../../src/context/part-repair-scheduler"
    const timers = new Set()
    export const flushRepairs = () => { const pending = [...timers]; timers.clear(); for (const fn of pending) fn() }
    export const createPartRepairScheduler = (options, repair) => realScheduler({ ...options, schedule: (fn, _delay) => { timers.add(fn); return () => timers.delete(fn) } }, repair)
    export const pages = []
    export const requests = []
    export const replays = []
    let listener
    export const emit = (key, seq, type, properties) => listener({name:key,details:{type,epoch:"test-epoch",seq,properties}})
    const ok = data => Promise.resolve({data})
    export function createSynergyClient(options) {
      return {
        scope: { bootstrap: () => options.directory.startsWith("background.") ? ok({scopeID:options.directory,provider:{all:[]},agent:[],config:{}}) : new Promise(resolve => requests.push({key:options.directory,resolve,done:false})) },
        permission: {list:()=>ok([])}, question: {list:()=>ok([])},
        event:{replay:()=>new Promise(resolve=>replays.push(resolve))},
        session:{list:()=>ok({total:0,data:[]}),inbox:()=>ok([]),messagePage:(_input, options)=>new Promise(resolve=>pages.push({resolve,signal:options.signal}))},
      }
    }
    export const useGlobalSDK = () => ({connected:()=>false,event:{listen:fn=>{listener=fn;return()=>{listener=undefined}}},url:'http://localhost/',client:{
      config:{global:()=>ok({})},global:{health:()=>ok({healthy:true}),paths:{get:()=>ok({})},agenda:{list:()=>ok([])}},
      scope:{list:()=>ok([])},provider:{list:()=>ok({all:[]}),auth:()=>ok({})},
    }})
    export const LocaleConfigReconciler=()=>null
    export const FatalErrorPage=()=> <div>failure</div>
    export const DialogSelectServer=()=>null
    export const useDialog=()=>({show(){}})
    export const showToast=()=>{}
    export const browserPerformanceEnabled=()=>false
    export const startBrowserPerformanceMetrics=()=>{}
    export const stopBrowserPerformanceMetrics=()=>{}
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
    import { requests, emit, pages, flushRepairs } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api, ready
      const started = new Promise(resolve=>ready=resolve)
      function Child(){api=useGlobalSync();ready();return <div>ready</div>}
      const dispose=render(()=><I18nProvider i18n={setupI18n({locale:'en',messages:{en:{}}})}><GlobalSyncProvider><Child/></GlobalSyncProvider></I18nProvider>,root)
      return {started,dispose,emit,pages,flushRepairs,api:()=>api,
        completePage(index, messageID) { pages[index].resolve({data:{items:[{info:{id:messageID,sessionID:"fixture-session",role:"user",time:{created:2}},parts:[]}],referencedRoots:[],nextCursor:null,hasMore:false,total:1}}) },
        complete(key,data,version) {
          const request=requests.find(r=>!r.done&&r.key===key)
          if(!request) throw new Error("no pending bootstrap for "+key)
          request.done=true
          const headers=version?{get:name=>name==="x-synergy-seq"?String(version.seq):name==="x-synergy-epoch"?version.epoch:undefined}:undefined
          request.resolve({data,response:headers?{headers}:undefined})
        },
        waitForRequest(key) {return new Promise(resolve=>{const check=()=>{if(requests.some(r=>!r.done&&r.key===key))return resolve();setTimeout(check,5)};check()})},
        waitComplete(state) {return new Promise(resolve=>createRoot(dispose=>createComputed(()=>{if(state[0].status==='complete'){dispose();resolve()}})))},
        watchPeek(key,sink) {return createRoot(dispose=>{createComputed(()=>sink(api.peekScopeState(key)));return dispose})},
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

      const retained = api.retainScopeState("repair")
      await h.waitForRequest("repair")
      h.complete("repair", { scopeID: "scope-repair", provider: { all: [] }, agent: [], config: {} })
      await h.waitComplete(retained.state)
      const [state, setState] = retained.state
      const sessionID = "fixture-session"
      let seq = 0
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
      const seed = (mode: "latest" | "history") => {
        setState("message", sessionID, [
          { id: "old", sessionID, role: "user", time: { created: 1 } },
        ] as (typeof state.message)[string])
        setState("messageWindow", sessionID, {
          mode,
          nextCursor: "older",
          hasMore: true,
          total: 10,
          pendingLatest: true,
          pendingLatestIds: ["new"],
          tailMissingLatest: true,
        })
      }
      const dropped = () =>
        h.emit("repair", ++seq, "message.part.updated", {
          part: { id: "p", sessionID, messageID: "new", type: "text", text: "new" },
        })

      seed("history")
      h.emit("repair", ++seq, "message.part.removed", { sessionID, messageID: "new", partID: "p" })
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(0)
      expect(state.messageWindow[sessionID]?.mode).toBe("history")

      seed("latest")
      dropped()
      seed("history")
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(0)

      seed("latest")
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(1)
      seed("history")
      h.completePage(0, "new")
      await tick()
      expect(state.message[sessionID]?.map((message) => message.id)).toEqual(["old"])
      expect(state.messageWindow[sessionID]?.mode).toBe("history")
      expect(state.messageWindow[sessionID]?.pendingLatestIds).toEqual(["new"])

      seed("latest")
      const diff = [{ file: "file.ts", before: "a", after: "b", additions: 1, deletions: 1 }]
      setState("session_diff", sessionID, diff)
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(2)
      h.completePage(1, "new")
      await tick()
      expect(state.message[sessionID]?.map((message) => message.id)).toEqual(["new"])
      expect(state.session_diff[sessionID]).toEqual(diff)

      seed("latest")
      dropped()
      setState("inbox", sessionID, [{ id: "queued" }] as (typeof state.inbox)[string])
      h.emit("repair", ++seq, "session.compacted", { sessionID })
      await tick()
      expect(h.pages).toHaveLength(3)
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(3)
      expect(h.pages[2]!.signal.aborted).toBe(false)
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(3)
      expect(h.pages[2]!.signal.aborted).toBe(false)
      // Use the old message so a newer out-of-window mark does not supersede this page.
      h.completePage(2, "old")
      await tick()
      expect(state.session_diff[sessionID]).toBeUndefined()
      expect(state.inbox[sessionID]).toBeUndefined()

      seed("latest")
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(4)
      h.emit("repair", ++seq, "session.compacted", { sessionID })
      await tick()
      expect(h.pages).toHaveLength(5)
      expect(h.pages[3]!.signal.aborted).toBe(true)
      h.completePage(4, "new")
      await tick()
      h.completePage(3, "obsolete")
      await tick()
      expect(state.message[sessionID]?.map((message) => message.id)).toEqual(["new"])

      const textPart = { id: "text", sessionID, messageID: "new", type: "text", text: "abcdef" }
      h.emit("repair", ++seq, "message.part.updated", { part: textPart })
      h.emit("repair", ++seq, "message.part.updated", { part: { ...textPart, text: "abc" }, delta: "c" })
      expect(state.part["new"]?.[0]).toMatchObject({ text: "abcdef" })
      h.emit("repair", ++seq, "message.part.updated", { part: { ...textPart, text: "abc" } })
      expect(state.part["new"]?.[0]).toMatchObject({ text: "abc" })

      seed("latest")
      dropped()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(6)
      dropped()
      retained.release()
      h.flushRepairs()
      await tick()
      expect(h.pages).toHaveLength(6)
      expect(h.pages[5]!.signal.aborted).toBe(true)
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
