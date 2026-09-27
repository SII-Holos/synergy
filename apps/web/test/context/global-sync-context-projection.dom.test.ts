import { expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@ericsanchezok/synergy-sdk/client"
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
  }
}

test("context usage advances without rewriting retained transcript messages", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".context-projection-"))
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
        scope: { bootstrap: () => options.scopeID.startsWith("background.") ? ok({scopeID:options.scopeID,provider:{all:[]},agent:[],config:{}}) : new Promise(resolve => requests.push({key:options.scopeID,resolve,done:false})) },
        permission: {list:()=>ok([])}, question: {list:()=>ok([])},
        event:{replay:()=>new Promise(resolve=>replays.push(resolve))},
        session:{list:()=>ok({total:0,data:[]}),inbox:()=>ok([])},
      }
    }
    export const useGlobalSDK = () => ({capabilities:{load:async()=>{},has:()=>true},prepareScopeState(){},connected:()=>false,event:{listen:fn=>{listener=fn;return()=>{listener=undefined}}},url:'http://localhost/',client:{
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

      const retained = api.retainScopeState("repair")
      await h.waitForRequest("repair")
      h.complete("repair", { scopeID: "scope-repair", provider: { all: [] }, agent: [], config: {} })
      await h.waitComplete(retained.state)
      const [state, setState] = retained.state
      const sessionID = "fixture-session"
      let seq = 0
      setState("message", sessionID, [])
      setState("messageWindow", sessionID, {
        mode: "latest",
        nextCursor: null,
        hasMore: false,
        total: 0,
        pendingLatest: false,
        pendingLatestIds: [],
        tailMissingLatest: false,
      })
      const messages: Message[] = []
      const snapshot = (message: Message) => JSON.parse(JSON.stringify(message)) as Message
      const assistant = (id: string, rootID: string, created: number): AssistantMessage => ({
        id,
        sessionID,
        role: "assistant",
        rootID,
        parentID: rootID,
        visible: true,
        time: { created, completed: created + 1 },
        finish: "stop",
        mode: "synergy",
        agent: "synergy",
        modelID: "model",
        providerID: "fixture",
        path: { cwd: null, root: null },
        cost: 0,
        tokens: { input: created, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      for (let turn = 0; turn < 4; turn++) {
        const rootID = `user-${turn}`
        const root: Message = {
          id: rootID,
          sessionID,
          role: "user",
          rootID,
          isRoot: true,
          visible: true,
          time: { created: turn * 10 },
          agent: "synergy",
          model: { providerID: "fixture", modelID: "model" },
        }
        const reply = assistant(`assistant-${turn}`, rootID, turn * 10 + 1)
        for (const info of [root, reply]) {
          messages.push(snapshot(info))
          h.emit("repair", ++seq, "message.updated", { info })
        }
        expect(state.message[sessionID]).toEqual(messages)
        expect(state.latestContextMessage[sessionID]?.id).toBe(reply.id)
        // Metadata enrichment of the same entity preserves its reactive identity.
        const retainedReply = state.message[sessionID]!.at(-1)
        const enriched = { ...reply, tokens: { ...reply.tokens, input: 100 + turn } }
        messages[messages.length - 1] = snapshot(enriched)
        h.emit("repair", ++seq, "message.updated", { info: enriched })
        expect(state.message[sessionID]!.at(-1)).toBe(retainedReply)
        expect(state.message[sessionID]).toEqual(messages)
      }

      // A latest-page snapshot can move the projection independently of the
      // visible history window; neither direction may mutate a retained row.
      const original = snapshot(state.message[sessionID]![1]!)
      api.setLatestContextMessage("repair", sessionID, state.message[sessionID]![1]!)
      expect(state.message[sessionID]).toEqual(messages)
      setState("messageWindow", sessionID, "mode", "history")
      const outside = assistant("outside", "outside-root", 100)
      h.emit("repair", ++seq, "message.updated", { info: outside })
      expect(state.latestContextMessage[sessionID]?.id).toBe("outside")
      expect(state.message[sessionID]).toEqual(messages)
      expect(state.message[sessionID]![1]).toEqual(original)
      expect(state.messageWindow[sessionID]?.pendingLatestIds).toEqual(["outside"])
      api.setLatestContextMessage("repair", sessionID, null)
      expect(state.latestContextMessage[sessionID]).toBeNull()
      expect(state.message[sessionID]).toEqual(messages)
      api.setLatestContextMessage("repair", sessionID, undefined)
      expect(state.latestContextMessage[sessionID]).toBeUndefined()
      expect(state.message[sessionID]).toEqual(messages)
      retained.release()
    } finally {
      h.dispose()
    }
  } finally {
    root.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
