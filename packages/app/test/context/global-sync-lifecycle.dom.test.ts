import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

test("Scope leases protect overlapping pages and reject released bootstrap results", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".scope-lifecycle-"))
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
    export const lists = []
    export const inboxRequests = []
    let inboxReady
    export const inboxArrived = new Promise(resolve=>inboxReady=resolve)
    let listener
    export const emit = (key,seq)=>listener({name:key,details:{type:"session.status",epoch:"test-epoch",seq,properties:{sessionID:"fixture-session",status:{type:"idle"}}}})
    const ok = data => Promise.resolve({data})
    export function createSynergyClient(options) {
      return {
        scope: { bootstrap: () => options.directory.startsWith("background.") ? ok({scopeID:options.directory,provider:{all:[]},agent:[],config:{}}) : new Promise(resolve => requests.push({key:options.directory,resolve})) },
        permission: {list:()=>ok([])}, question: {list:()=>ok([])},
        event:{replay:()=>new Promise(resolve=>replays.push(resolve))},
        session:{list:()=>new Promise(resolve=>lists.push(resolve)),inbox:()=>{inboxRequests.push(options.directory);inboxReady();return ok([])}},
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
    import { requests, replays, lists, emit, inboxRequests, inboxArrived } from ${JSON.stringify(stub)}
    export function mount(root) {
      let api, ready
      const started = new Promise(resolve=>ready=resolve)
      function Child(){api=useGlobalSync();ready();return <div>ready</div>}
      const dispose=render(()=><I18nProvider i18n={setupI18n({locale:'en',messages:{en:{}}})}><GlobalSyncProvider><Child/></GlobalSyncProvider></I18nProvider>,root)
      return {started,dispose,requests,emit,replays,lists,inboxRequests,inboxArrived,api:()=>api,
        seedInbox(key) {api.ensureScopeState(key)[1]("inbox","fixture-session",[{id:"pending"}])},
        complete(index,version) {const request=requests[index];request.resolve({data:{scopeID:request.key,provider:{all:[]},agent:[],config:{version}}})},
        waitComplete(state) {return new Promise(resolve=>createRoot(dispose=>createComputed(()=>{if(state[0].status==='complete'){dispose();resolve()}})))},
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
    type State = [
      {
        status: string
        config: { version?: string }
        session: unknown[]
        session_status: Record<string, unknown>
        latestContextMessage: Record<string, unknown>
      },
      unknown,
    ]
    type API = {
      retainScopeState(key: string): { state: State; release(): void }
      peekScopeState(key: string): State | undefined
      ensureScopeState(key: string): State
      beginContextProjection(key: string, sessionID: string): number
      setLatestContextMessage(key: string, sessionID: string, message: null, revision: number): void
      failure: unknown
      scope: { loadSessions(key: string): Promise<void> }
    }
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as {
      mount(root: Element): {
        started: Promise<void>
        dispose(): void
        api(): API
        complete(index: number, version: string): void
        requests: unknown[]
        emit(key: string, seq: number): void
        seedInbox(key: string): void
        inboxRequests: string[]
        inboxArrived: Promise<void>
        replays: Array<(value: unknown) => void>
        lists: Array<(value: unknown) => void>
        waitComplete(state: State): Promise<void>
      }
    }
    const h = fixture.mount(root)
    try {
      await h.started
      const api = h.api()
      const old = api.retainScopeState("shared")
      const next = api.retainScopeState("shared")
      expect(next.state).toBe(old.state)
      old.release()
      expect(api.peekScopeState("shared")).toBe(next.state)
      next.release()
      expect(api.peekScopeState("shared")).toBeUndefined()
      const reopened = api.retainScopeState("shared")
      expect(reopened.state).not.toBe(old.state)
      expect(h.requests.length).toBe(2)
      h.complete(1, "new")
      await h.waitComplete(reopened.state)
      h.complete(0, "obsolete")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reopened.state[0].config.version).toBe("new")
      expect(old.state[0].config.version).toBeUndefined()
      expect(api.failure).toBeUndefined()
      old.release()
      expect(api.peekScopeState("shared")).toBe(reopened.state)
      h.emit("shared", 1)
      h.emit("shared", 3)
      h.emit("shared", 5)
      expect(h.replays.length).toBe(1)
      const oldList = api.scope.loadSessions("shared")
      reopened.release()
      const current = api.retainScopeState("shared")
      h.complete(2, "current")
      await h.waitComplete(current.state)
      h.emit("shared", 1)
      h.emit("shared", 3)
      expect(h.replays.length).toBe(2)
      h.replays[0]!({
        data: {
          status: "ok",
          epoch: "test-epoch",
          seq: 5,
          events: [{ type: "session.status", properties: { sessionID: "obsolete-session", status: { type: "busy" } } }],
        },
      })
      h.lists[0]!({ data: { total: 1, data: [{ id: "obsolete-session" }] } })
      await oldList
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(current.state[0].session).toEqual([])
      expect(current.state[0].session_status["obsolete-session"]).toBeUndefined()
      expect(h.replays.length).toBe(2)
      h.replays[1]!({ data: { status: "ok", epoch: "test-epoch", seq: 3, events: [] } })
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 12; i++) api.ensureScopeState("background." + i)
      expect(api.peekScopeState("background.0")).toBeUndefined()
      expect(api.peekScopeState("background.11")).toBeDefined()
      expect(api.peekScopeState("shared")).toBe(current.state)
      const pendingRevision = api.beginContextProjection("shared", "never-loaded")
      current.release()
      expect(api.peekScopeState("shared")).toBeUndefined()
      const latest = api.retainScopeState("shared")
      api.setLatestContextMessage("shared", "never-loaded", null, pendingRevision)
      expect(latest.state[0].latestContextMessage["never-loaded"]).toBeUndefined()
      latest.release()
      const first = api.retainScopeState("/repo")
      const neighbor = api.retainScopeState("/repo:variant")
      h.seedInbox("/repo")
      h.seedInbox("/repo:variant")
      h.emit("/repo", 1)
      h.emit("/repo:variant", 1)
      first.release()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          h.inboxArrived,
          new Promise(
            (_, reject) =>
              (timeout = setTimeout(() => reject(new Error("Neighbor Scope inbox timer was cancelled")), 5000)),
          ),
        ])
        expect(h.inboxRequests).toEqual(["/repo:variant"])
      } finally {
        clearTimeout(timeout)
        neighbor.release()
      }
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
