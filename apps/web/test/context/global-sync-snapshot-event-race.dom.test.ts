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
    sessionTotal: number
    cortex: Array<{ id: string; sessionID?: string }>
  },
  unknown,
]

type ScopeApi = {
  retainScopeState(key: string): { state: ScopeState; release(): void }
  ensureScopeState(key: string): ScopeState
  peekScopeState(key: string): ScopeState | undefined
  sessionStatus: Record<string, { type?: string }>
  permissions: Record<string, Array<{ id: string }> | undefined>
  questions: Record<string, Array<{ id: string }> | undefined>
  cortex: Array<{ id: string; parentSessionID?: string; status: string }>
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
    resolveEntry(sessionID: string): { tone?: string; pulse?: boolean }
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
    const stamped = data => Promise.resolve({data, response:{headers:{get:name=>name==="x-synergy-seq"?"0":name==="x-synergy-epoch"?"test-epoch":undefined}}})
    export function createSynergyClient(options) {
      return {
        scope: { bootstrap: () => options.scopeID.startsWith("background.") ? ok({scopeID:options.scopeID,provider:{all:[]},agent:[],config:{}}) : new Promise(resolve => requests.push({key:options.scopeID,resolve,done:false})) },
        permission: {list:()=>stamped([])}, question: {list:()=>stamped([])},
        event:{replay:()=>new Promise(resolve=>replays.push(resolve))},
        session:{list:()=>ok({total:0,data:[]}),inbox:()=>ok([])},
      }
    }
    export const useGlobalSDK = () => ({prepareScopeState(){},connected:()=>false,event:{listen:fn=>{listener=fn;return()=>{listener=undefined}}},url:'http://localhost/',client:{
      config:{global:()=>ok({})},global:{health:()=>ok({healthy:true}),paths:{get:()=>ok({})},agenda:{list:()=>ok([])}},
      scope:{list:()=>ok([])},provider:{list:()=>ok({all:[]}),auth:()=>ok({})},session:{statuses:()=>stamped({})},
      cortex:{list:()=>ok([])},
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
    import { requests, emit } from ${JSON.stringify(stub)}
    import { resolveSessionVisualState } from "@/components/sidebar/session-visual-state"
    export function mount(root) {
      let api, ready
      const started = new Promise(resolve=>ready=resolve)
      function Child(){api=useGlobalSync();ready();return <div>ready</div>}
      const dispose=render(()=><I18nProvider i18n={setupI18n({locale:'en',messages:{en:{}}})}><GlobalSyncProvider><Child/></GlobalSyncProvider></I18nProvider>,root)
      return {started,dispose,emit,api:()=>api,
      resolveEntry(sessionID) {
        return resolveSessionVisualState({
          entry: { id: sessionID },
          status: api.sessionStatus[sessionID],
          waiting: (api.permissions[sessionID]?.length ?? 0) > 0 || (api.questions[sessionID]?.length ?? 0) > 0,
          runningChildTasks: api.cortex.some(
            (task) => task.parentSessionID === sessionID && task.status === "running",
          ),
        })
      },
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

      // Releasing the last lease demotes a Scope into the inactive LRU rather
      // than evicting it, so eviction is forced by overfilling that LRU: the
      // registry keeps at most eight inactive Scopes, and creating a new one
      // evicts the oldest. The sweep keys must not reuse an existing background
      // key, because re-touching one only moves its LRU position instead of
      // growing the set. The precondition is asserted rather than assumed, so
      // this stays correct however many Scopes earlier steps left inactive.
      let sweep = 0
      const evictScope = async (key: string) => {
        for (let i = 0; i < 64 && api.peekScopeState(key); i++) api.ensureScopeState(`background.sweep.${sweep++}`)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(api.peekScopeState(key)).toBeUndefined()
      }

      // A busy status event and a session insert apply while the scope's
      // bootstrap response is still in flight. The response was stamped
      // before the server read its snapshot, so its seq is behind the
      // applied watermark and it must not reconcile the event writes away.
      const shared = api.retainScopeState("shared")
      h.emit("shared", 1, "session.status", { sessionID: "fixture-session", status: { type: "busy" } })
      h.emit("shared", 2, "session.updated", { info: { id: "live-added", time: {} } })
      expect(api.sessionStatus["fixture-session"]).toEqual({ type: "busy" })
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

      expect(api.sessionStatus["fixture-session"]).toEqual({ type: "busy" })
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
          sessions: {
            data: [
              { id: "snap-only", time: {} },
              { id: "missed-idle", time: {} },
            ],
            total: 2,
          },
          cortex: [{ id: "task-live", sessionID: "b-session" }],
        },
        { epoch: "test-epoch", seq: 6 },
      )
      await h.waitComplete(stale.state)
      expect(api.sessionStatus["missed-idle"]).toBeUndefined()
      expect(stale.state[0].session.some((session) => session.id === "b-session")).toBe(true)
      expect(stale.state[0].session.some((session) => session.id === "snap-only")).toBe(true)
      // The whole-bucket `cortex.tasks.updated` at seq 9 postdates the response
      // stamp (seq 6), so its empty list wins over the snapshot's task in the
      // global Cortex index — the same post-stamp discipline the per-Scope
      // bucket had, now applied to the eviction-independent carrier.
      expect(api.cortex.some((task) => task.id === "task-live")).toBe(false)
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
      expect(seen.length).toBe(2)
      for (let i = 0; i < 9; i++) api.ensureScopeState(`background.eviction.${i}`)
      expect(seen.length).toBeGreaterThan(2)
      expect(seen.at(-1)).toBeUndefined()
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
      expect(api.sessionStatus["other-session"]).toEqual({ type: "busy" })
      expect(fresh.state[0].session.some((session) => session.id === "snapshot-session")).toBe(true)
      fresh.release()

      // Session runtime state lives in the always-present global store keyed by
      // session id, not in the per-Scope store: the sidebar renders sessions
      // from every Scope, while a Scope store is evicted once enough Scopes are
      // inactive. Evicting "index-scope" below is exactly the switch-project
      // path that used to blank these values.
      const indexed = api.retainScopeState("index-scope")
      h.emit("index-scope", 1, "session.status", { sessionID: "watched", status: { type: "busy" } })
      expect(api.sessionStatus["watched"]).toEqual({ type: "busy" })
      h.emit("index-scope", 2, "permission.asked", {
        id: "perm-1",
        sessionID: "watched",
        permission: "edit",
        patterns: [],
        metadata: {},
      })
      h.emit("index-scope", 3, "question.asked", { id: "question-1", sessionID: "watched", questions: [] })
      expect(api.permissions["watched"]?.map((request) => request.id)).toEqual(["perm-1"])
      expect(api.questions["watched"]?.map((request) => request.id)).toEqual(["question-1"])

      indexed.release()
      await evictScope("index-scope")
      expect(api.sessionStatus["watched"]).toEqual({ type: "busy" })
      expect(api.permissions["watched"]?.map((request) => request.id)).toEqual(["perm-1"])
      expect(api.questions["watched"]?.map((request) => request.id)).toEqual(["question-1"])

      h.emit("index-scope", 4, "permission.replied", { sessionID: "watched", requestID: "perm-1" })
      h.emit("index-scope", 5, "question.timed_out", { sessionID: "watched", requestID: "question-1" })
      expect(api.permissions["watched"]).toBeUndefined()
      expect(api.questions["watched"]).toBeUndefined()

      // The index holds only non-idle sessions, so an idle status deletes the
      // key rather than storing a value every reader must filter out.
      h.emit("index-scope", 6, "session.status", { sessionID: "watched", status: { type: "idle" } })
      expect(api.sessionStatus["watched"]).toBeUndefined()

      // Requests stay id-sorted so a reader can binary-search them rather than
      // scanning, matching the per-Scope bucket shape.
      h.emit("index-scope", 7, "permission.asked", {
        id: "perm-2",
        sessionID: "sorted",
        permission: "edit",
        patterns: [],
        metadata: {},
      })
      h.emit("index-scope", 8, "permission.asked", {
        id: "perm-1",
        sessionID: "sorted",
        permission: "edit",
        patterns: [],
        metadata: {},
      })

      expect(api.permissions["sorted"]?.map((request) => request.id)).toEqual(["perm-1", "perm-2"])

      // Release the concurrency slot `index-scope` still holds. Its store is
      // already evicted, so the late response applies nothing (every apply path
      // re-checks that the live store is still the one that requested it) — it
      // only lets the convergence Scope below start its bootstrap.
      h.complete(
        "index-scope",
        {
          scopeID: "scope-index",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: {},
          sessions: { data: [], total: 0 },
        },
        { epoch: "test-epoch", seq: 0 },
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      // `recovering` reaches the client only through the snapshot route or a
      // session.updated `working` field, so the fallback fills a status the
      // index has no entry for and never overwrites one it does have — a real
      // status event always wins, mirroring SessionManager.listStatuses.
      const recovering = { status: "recovering" }
      h.emit("index-scope", 9, "session.updated", { info: { id: "derived", time: {}, working: recovering } })
      expect(api.sessionStatus["derived"]).toEqual({ type: "recovering" })
      h.emit("index-scope", 10, "session.updated", {
        info: { id: "derived", time: {}, working: { status: "retry", attempt: 1, message: "again", next: 2 } },
      })
      expect(api.sessionStatus["derived"]).toEqual({ type: "recovering" })
      h.emit("index-scope", 11, "session.status", { sessionID: "derived", status: { type: "busy" } })
      expect(api.sessionStatus["derived"]).toEqual({ type: "busy" })
      h.emit("index-scope", 12, "session.updated", { info: { id: "derived", time: {}, working: recovering } })
      expect(api.sessionStatus["derived"]).toEqual({ type: "busy" })
      // Convergence across eviction. A Scope's bootstrap response used to be
      // authoritative for its whole status bucket *including omissions*, so a
      // status left stale by a missed idle could not survive a resync. A flat
      // index cannot infer which omissions are deletions, so the bootstrap's
      // own session list supplies the Scope-owned set: a session that Scope
      // still lists, but which the snapshot no longer reports as running, is
      // deleted — while a status written by an event after the response stamp
      // is newer than the snapshot read and wins.
      const converging = api.retainScopeState("converge-scope")
      await h.waitForRequest("converge-scope")
      h.complete(
        "converge-scope",
        {
          scopeID: "scope-converge",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: { "stale-runner": { type: "busy" } },
          sessions: {
            data: [
              { id: "stale-runner", time: {} },
              { id: "fresh-runner", time: {} },
            ],
            total: 2,
          },
        },
        { epoch: "test-epoch", seq: 10 },
      )
      await h.waitComplete(converging.state)
      expect(api.sessionStatus["stale-runner"]).toEqual({ type: "busy" })

      h.emit("converge-scope", 11, "session.status", { sessionID: "fresh-runner", status: { type: "busy" } })
      expect(api.sessionStatus["fresh-runner"]).toEqual({ type: "busy" })

      // Switching project: the last lease goes, the Scope is evicted, and only
      // the global index still carries the runtime state.
      converging.release()
      await evictScope("converge-scope")

      const revived = api.retainScopeState("converge-scope")
      await h.waitForRequest("converge-scope")
      h.complete(
        "converge-scope",
        {
          scopeID: "scope-converge",
          provider: { all: [] },
          agent: [],
          config: {},
          sessionStatus: {},
          sessions: {
            data: [
              { id: "stale-runner", time: {} },
              { id: "fresh-runner", time: {} },
            ],
            total: 2,
          },
        },
        { epoch: "test-epoch", seq: 12 },
      )
      // Emitted between the response being stamped (seq 12) and its fields
      // being applied, so it postdates the read: the snapshot must not clear it.
      h.emit("converge-scope", 13, "session.status", { sessionID: "fresh-runner", status: { type: "busy" } })
      await h.waitComplete(revived.state)
      expect(api.sessionStatus["stale-runner"]).toBeUndefined()
      expect(api.sessionStatus["fresh-runner"]).toEqual({ type: "busy" })
      revived.release()
      // The delegated-child pulse is the third resolver input that lives in a
      // global index. A session with no status of its own is the interesting
      // case: its running child task is the only input that can make the row
      // read as running, and it must keep doing so after its Scope is evicted.
      // The pulse previously came from the Scope store's Cortex bucket, so a
      // resting row lost its running state on a project switch while its task
      // was still running.
      const pulseScope = api.retainScopeState("pulse-scope")
      h.emit("pulse-scope", 1, "cortex.task.created", {
        task: { id: "task-pulse", parentSessionID: "resting-child", status: "running" },
      })
      expect(api.sessionStatus["resting-child"]).toBeUndefined()
      expect(h.resolveEntry("resting-child")).toMatchObject({ tone: "active", pulse: true })
      pulseScope.release()
      await evictScope("pulse-scope")
      expect(api.cortex.some((task) => task.id === "task-pulse" && task.status === "running")).toBe(true)
      expect(h.resolveEntry("resting-child")).toMatchObject({ tone: "active", pulse: true })
      shared.release()
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
