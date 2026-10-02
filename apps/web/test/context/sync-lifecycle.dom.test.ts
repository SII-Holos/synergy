import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"
test("SyncProvider aborts message loading and releases its Scope on unmount", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-memory-"))
  const entry = path.join(dir, "main.tsx"),
    stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx"),
    helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  await Bun.write(
    stub,
    `
 import {createStore} from 'solid-js/store';
 const state=createStore({status:'ready',message:{},messageWindow:{},latestContextMessage:{},session:[],path:{directory:''}});
 let notifyStarted;export const started=new Promise(resolve=>notifyStarted=resolve);
 export const stats={released:0,signal:null,reject:null};
 export const useGlobalSync=()=>({retainContentCache:(_key,create)=>({cache:create(),release(){}}),retainScopeState:()=>({state,release:()=>stats.released++}),scopeReconnectVersion:()=>0,capturePartSnapshotRequest:()=>({}),captureResourceRequest:()=>({}),beginContextProjection:()=>0});
 export const refreshPlanBlueprintOfferFromLoadedParts=()=>{};export const updatePlanBlueprintOfferState=()=>{};
 export const useSDK=()=>({scopeKey:'probe',client:{session:{timelinePage:(_input,options)=>{stats.signal=options.signal;return new Promise((resolve,reject)=>{stats.reject=reject;notifyStarted()})}}}});
 `,
  )
  await Bun.write(
    entry,
    `
 import {render} from 'solid-js/web';import {SyncProvider,useSync} from ${JSON.stringify(sync)};import {stats,started} from ${JSON.stringify(stub)};
 let api;function Child(){api=useSync();return <div>probe</div>}
 const dispose=render(()=><SyncProvider><Child/></SyncProvider>,document.getElementById('root'));
 globalThis.syncMemoryProbe={stats,started,dispose,start:()=>api.session.history.returnLatest('probe-session').catch(()=>{})};
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
          stats: { released: number; signal: AbortSignal; reject: (e: Error) => void }
          started: Promise<void>
          dispose: () => void
          start: () => Promise<void>
        }
      }
    ).syncMemoryProbe
    const pending = h.start()
    await h.started
    h.dispose()
    const result = { released: h.stats.released, aborted: h.stats.signal.aborted }
    h.stats.reject(new Error("fixture complete"))
    await pending
    expect(result).toEqual({ released: 1, aborted: true })
  } finally {
    root.remove()
    delete (globalThis as { syncMemoryProbe?: unknown }).syncMemoryProbe
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
