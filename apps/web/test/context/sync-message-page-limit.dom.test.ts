import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type MessagePageCall = { sessionID: string; limit: number; cursor?: string }

type Harness = {
  calls: { messagePage: MessagePageCall[]; permissionList: Array<unknown> }
  run: () => Promise<void>
  dispose: () => void
}

test("an initial latest load requests the rendered-bound page while history and refresh paths retain the summary page budget", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-page-limit-"))
  const entry = path.join(dir, "main.tsx"),
    stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx"),
    helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  const freshnessPath = path.resolve(import.meta.dir, "../../src/context/session-part-snapshot-freshness.ts")
  await Bun.write(
    stub,
    `
import {createStore} from 'solid-js/store';
import { SessionPartSnapshotFreshness } from ${JSON.stringify(freshnessPath)};
const freshness = new SessionPartSnapshotFreshness();
const state=createStore({status:'ready',path:{directory:''},scopeID:'home',session:[],message:{},messageWindow:{},latestContextMessage:{},part:{},partSummary:{},partPage:{},partVersion:{},permission:{},question:{},inbox:{},todo:{},dag:{},session_diff:{},cortex:[]});
export const calls={messagePage:[],permissionList:[]};
export const useGlobalSync=()=>({retainContentCache:(_key,create)=>({cache:create(),release(){}}),
  data:{scope:[]},
  retainScopeState:()=>({state,release:()=>{}}),
  peekScopeState:()=>state,
  scopeReconnectVersion:()=>0,
  capturePartSnapshotRequest:(_scope,sessionID)=>freshness.capture('probe',sessionID),
  captureResourceRequest:()=>({}),
  beginContextProjection:()=>0,
  partSnapshotAction:(_scope,sessionID,messageID,request)=>freshness.action('probe',sessionID,messageID,request),
  partSnapshotGenerationDrifted:(_scope,sessionID,request)=>freshness.generationDrifted('probe',sessionID,request),
  applyResourceResponse:(_scopeKey,_sessionID,_resource,_request,_headers,apply)=>{apply();return true},
  setLatestContextMessage:()=>{},
  touchMessageBucket:()=>{},
  invalidateResource:()=>{},
  markActiveSession:()=>{},
  reconcileCortexFromSession:()=>{},
  seedSessionPermissions:()=>{},
});
export const refreshPlanBlueprintOfferFromLoadedParts=()=>{};
export const updatePlanBlueprintOfferState=()=>{};
const page=()=>({data:{items:[],referencedRoots:[],nextCursor:'cursor_1',hasMore:true,total:0},response:{headers:{get:()=>null}}});
export const useSDK=()=>({scopeKey:'probe',scopeID:'home',directory:'/probe',isHome:true,client:{
  permission:{list:(input)=>{calls.permissionList.push(input);return Promise.resolve({data:[]})}},
  session:{
    get:()=>Promise.resolve({data:{id:'ses_probe',time:{created:0,updated:0}}}),
    inbox:()=>Promise.resolve({data:[]}),
    timelinePage:(input)=>{
      calls.messagePage.push({sessionID:input.sessionID,limit:input.limit,...(input.cursor?{cursor:input.cursor}:{})});
      return Promise.resolve(page());
    },
  },
}});
`,
  )
  await Bun.write(
    entry,
    `
import {render} from 'solid-js/web';import {SyncProvider,useSync} from ${JSON.stringify(sync)};import {calls} from ${JSON.stringify(stub)};
let api;function Child(){api=useSync();return <div>probe</div>}
const dispose=render(()=><SyncProvider><Child/></SyncProvider>,document.getElementById('root'));
export const harness={calls,dispose,run:async()=>{
  await api.session.sync('ses_initial');
  await api.session.history.loadMore('ses_initial');
  await api.session.history.returnLatest('ses_initial');
  await api.session.sync('ses_other');
}};
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
    const harness = ((await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)) as { harness: Harness })
      .harness
    await harness.run()

    expect(harness.calls.permissionList).toEqual([{ sessionID: "ses_initial" }, { sessionID: "ses_other" }])
    expect(harness.calls.messagePage).toEqual([
      { sessionID: "ses_initial", limit: 100 },
      { sessionID: "ses_initial", limit: 100, cursor: "cursor_1" },
      { sessionID: "ses_initial", limit: 100 },
      { sessionID: "ses_other", limit: 100 },
    ])
    harness.dispose()
  } finally {
    root.remove()
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
