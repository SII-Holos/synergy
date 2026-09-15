import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type SnapshotVersion = { epoch: string; seq: number }

type ScopeState = [
  {
    status: string
    session: Array<{ id: string }>
    session_status: Record<string, { type?: string }>
    sessionTotal: number
    cortex: Array<{ id: string; sessionID?: string }>
  },
  unknown,
]

type ScopeApi = {
  retainScopeState(key: string): { state: ScopeState; release(): void }
  ensureScopeState(key: string): ScopeState
  peekScopeState(key: string): ScopeState | undefined
}

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
  }
}

test("bootstrap snapshots behind the applied watermark keep event state; store registry stays reactive", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".snapshot-race-"))
  const entry = path.join(directory, "main.tsx")
  const stub = path.join(directory, "services.tsx")
  const globalSync = path.resolve(import.meta.dir, "../../src/context/global-sync.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  await Bun.write(
    stub,
    `
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
        session:{list:()=>ok({total:0,data:[]}),inbox:()=>ok([])},
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
    import { requests, emit } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api, ready
      const started = new Promise(resolve=>ready=resolve)
      function Child(){api=useGlobalSync();ready();return <div>ready</div>}
      const dispose=render(()=><I18nProvider i18n={setupI18n({locale:'en',messages:{en:{}}})}><GlobalSyncProvider><Child/></GlobalSyncProvider></I18nProvider>,root)
      return {started,dispose,emit,api:()=>api,
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

      // A busy status event and a session insert apply while the scope's
      // bootstrap response is still in flight. The response was stamped
      // before the server read its snapshot, so its seq is behind the
      // applied watermark and it must not reconcile the event writes away.
      const shared = api.retainScopeState("shared")
      h.emit("shared", 1, "session.status", { sessionID: "fixture-session", status: { type: "busy" } })
      h.emit("shared", 2, "session.updated", { info: { id: "live-added", time: {} } })
      expect(shared.state[0].session_status["fixture-session"]).toEqual({ type: "busy" })
      expect(shared.state[0].session.some((session) => session.id === "live-added")).toBe(true)

      h.complete(
        "shared",
        {
          scopeID: "scope-shared",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: {},
          sessions: { data: [{ id: "from-snapshot", time: {} }], total: 1 },
        },
        { epoch: "test-epoch", seq: 0 },
      )
      await h.waitComplete(shared.state)

      expect(shared.state[0].session_status["fixture-session"]).toEqual({ type: "busy" })
      expect(shared.state[0].session.some((session) => session.id === "live-added")).toBe(true)
      expect(shared.state[0].session.some((session) => session.id === "from-snapshot")).toBe(true)
      // Reviewer scenario: the response stamp sits between an old stale
      // write and a newer unrelated event. Scope-wide "snapshot is behind"
      // merging keeps every local entry; only keys written after the stamp
      // may keep their event value, and post-stamp deletions must not be
      // resurrected from the older snapshot read.
      const stale = api.retainScopeState("stale-scope")
      h.emit("stale-scope", 5, "session.status", { sessionID: "missed-idle", status: { type: "busy" } })
      h.emit("stale-scope", 6, "session.diff", { sessionID: "missed-idle", diff: [] })
      h.emit("stale-scope", 7, "session.updated", { info: { id: "b-session", time: {} } })
      h.emit("stale-scope", 8, "cortex.task.created", { task: { id: "task-live", sessionID: "b-session" } })
      h.emit("stale-scope", 9, "cortex.tasks.updated", { tasks: [] })
      h.complete(
        "stale-scope",
        {
          scopeID: "scope-stale",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: {},
          sessions: { data: [{ id: "snap-only", time: {} }], total: 1 },
          cortex: [{ id: "task-live", sessionID: "b-session" }],
        },
        { epoch: "test-epoch", seq: 6 },
      )
      await h.waitComplete(stale.state)
      expect(stale.state[0].session_status["missed-idle"]).toBeUndefined()
      expect(stale.state[0].session.some((session) => session.id === "b-session")).toBe(true)
      expect(stale.state[0].session.some((session) => session.id === "snap-only")).toBe(true)
      expect(stale.state[0].cortex.some((task) => task.id === "task-live")).toBe(false)
      stale.release()
      // The store registry is reactive: a consumer that observed undefined
      // before the store existed re-runs on creation and on eviction.
      const seen: Array<ScopeState | undefined> = []
      const stopWatch = h.watchPeek("registry-probe", (state) => seen.push(state))
      expect(seen.length).toBe(1)
      expect(seen[0]).toBeUndefined()
      api.ensureScopeState("registry-probe")
      expect(seen.length).toBe(2)
      expect(seen[1]).toBeDefined()
      await h.waitForRequest("registry-probe")
      h.complete("registry-probe", { scopeID: "scope-probe", provider: { all: [] }, agent: [], config: {} })
      api.retainScopeState("registry-probe").release()
      expect(seen.length).toBe(3)
      expect(seen[2]).toBeUndefined()
      stopWatch()

      // A snapshot with no newer events applied still populates the store.
      api.ensureScopeState("fresh-scope")
      await h.waitForRequest("fresh-scope")
      h.complete(
        "fresh-scope",
        {
          scopeID: "scope-fresh",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: { "other-session": { type: "busy" } },
          sessions: { data: [{ id: "snapshot-session", time: {} }], total: 1 },
        },
        { epoch: "test-epoch", seq: 0 },
      )
      const fresh = api.retainScopeState("fresh-scope")
      await h.waitComplete(fresh.state)
      expect(fresh.state[0].session_status["other-session"]).toEqual({ type: "busy" })
      expect(fresh.state[0].session.some((session) => session.id === "snapshot-session")).toBe(true)
      fresh.release()
      shared.release()
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
