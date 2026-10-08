import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"
test.each(["dispose", "rebind", "epoch"] as const)(
  "SyncProvider fences pending metadata and diff after %s",
  async (change) => {
    const dir = await mkdtemp(path.join(import.meta.dir, ".sync-memory-"))
    const entry = path.join(dir, "main.tsx"),
      stub = path.join(dir, "stub.tsx")
    const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx"),
      helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
    await Bun.write(
      stub,
      `
 import {createStore} from 'solid-js/store';
 const createState=()=>createStore({status:'ready',message:{},messageWindow:{},latestContextMessage:{},session:[],session_diff:{},inbox:{},path:{directory:''}});
 const state=createState();let current=state;
 let notifyStarted;export const started=new Promise(resolve=>notifyStarted=resolve);
 export const stats={released:0,generation:0,signal:null,reject:null,metadataSignal:null,diffSignal:null,metadataReply:null,diffReply:null,cortexWrites:0};
 export const replaceState=()=>{current=createState()};
 export const snapshot=()=>({sessions:state[0].session.length,diffs:Object.keys(state[0].session_diff).length,cortexWrites:stats.cortexWrites});
 export const useGlobalSync=()=>({retainContentCache:(_key,create)=>({cache:create(),release(){}}),retainScopeState:()=>({state,release:()=>stats.released++}),peekScopeState:()=>current,scopeReconnectVersion:()=>0,capturePartSnapshotRequest:()=>({}),captureResourceRequest:()=>({generation:stats.generation}),beginContextProjection:()=>0,applyResourceResponse:(_scope,_session,_resource,_request,_headers,apply)=>{apply();return true},seedSessionPermissions:()=>{},reconcileCortexFromSession:()=>stats.cortexWrites++});
 export const refreshPlanBlueprintOfferFromLoadedParts=()=>{};export const updatePlanBlueprintOfferState=()=>{};
 export const useSDK=()=>({scopeKey:'probe',client:{permission:{list:()=>Promise.resolve({data:[]})},session:{
 get:(_input,options)=>{stats.metadataSignal=options?.signal;return new Promise(resolve=>{stats.metadataReply=resolve})},
 diff:(_input,options)=>{stats.diffSignal=options?.signal;return new Promise(resolve=>{stats.diffReply=resolve})},
 inbox:()=>Promise.resolve({data:[]}),
 timelinePage:(_input,options)=>{stats.signal=options.signal;return new Promise((resolve,reject)=>{stats.reject=reject;notifyStarted()})}}}});
 `,
    )
    await Bun.write(
      entry,
      `
 import {render} from 'solid-js/web';import {SyncProvider,useSync} from ${JSON.stringify(sync)};import {stats,started,snapshot,replaceState} from ${JSON.stringify(stub)};
 let api;function Child(){api=useSync();return <div>probe</div>}
 const dispose=render(()=><SyncProvider><Child/></SyncProvider>,document.getElementById('root'));
 globalThis.syncMemoryProbe={stats,started,dispose,snapshot,replaceState,start:()=>Promise.allSettled([api.session.sync('probe-session'),api.session.diff('probe-session')])};
 `,
    )
    const root = document.createElement("div")
    root.id = "root"
    document.body.append(root)
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        resolve: {
          alias: [
            { find: /^@ericsanchezok\/synergy-ui\/context$/, replacement: helper },
            { find: "@", replacement: path.resolve(import.meta.dir, "../../src") },
          ],
        },
        plugins: [
          {
            name: "scope-fixture",
            enforce: "pre",
            resolveId(source, importer) {
              if (importer === sync && ["./global-sync", "./sdk"].includes(source)) return stub
            },
          },
          solidPlugin(),
        ],
        build: {
          outDir: path.join(dir, "dist"),
          minify: false,
          lib: { entry, formats: ["es"], fileName: "fixture" },
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      })
      await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)
      const h = (
        globalThis as unknown as {
          syncMemoryProbe: {
            stats: {
              released: number
              generation: number
              signal: AbortSignal
              metadataSignal?: AbortSignal
              diffSignal?: AbortSignal
              reject: (e: Error) => void
              metadataReply: (data: unknown) => void
              diffReply: (data: unknown) => void
            }
            started: Promise<void>
            dispose: () => void
            start: () => Promise<unknown>
            replaceState(): void
            snapshot(): { sessions: number; diffs: number; cortexWrites: number }
          }
        }
      ).syncMemoryProbe
      const pending = h.start()
      await h.started
      if (change === "dispose") h.dispose()
      else if (change === "rebind") h.replaceState()
      else h.stats.generation++
      h.stats.metadataReply({ data: { id: "probe-session", time: { created: 0, updated: 0 } } })
      h.stats.diffReply({ data: [{ file: "fixture.ts", before: "old", after: "new", additions: 1, deletions: 1 }] })
      h.stats.reject(new Error("fixture complete"))
      await pending
      expect(h.snapshot()).toEqual({ sessions: 0, diffs: 0, cortexWrites: 0 })
      if (change === "dispose") {
        expect(h.stats.released).toBe(1)
        expect([h.stats.signal, h.stats.metadataSignal, h.stats.diffSignal].map((signal) => signal?.aborted)).toEqual([
          true,
          true,
          true,
        ])
      } else h.dispose()
    } finally {
      root.remove()
      delete (globalThis as { syncMemoryProbe?: unknown }).syncMemoryProbe
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000,
)
