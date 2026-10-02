import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type MessagePageCall = { sessionID: string; limit: number; cursor?: string }

type Harness = {
  calls: { messagePage: MessagePageCall[]; permissionList: Array<unknown> }
  run: () => Promise<Array<{ messages: string[]; parts: string[] }>>
  dispose: () => void
}

test("history transitions replace branches while reconnect preserves the retained history window", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-history-"))
  const entry = path.join(dir, "main.tsx"),
    stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx"),
    helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  await Bun.write(
    stub,
    `
import {createStore} from 'solid-js/store';
const state=createStore({status:'ready',path:{directory:''},scopeID:'home',session:[],message:{},messageWindow:{},latestContextMessage:{},part:{},partSummary:{},partPage:{},partVersion:{},permission:{},question:{},inbox:{},todo:{},dag:{},session_diff:{},cortex:[]});
export const calls={messagePage:[],permissionList:[]};
export const useGlobalSync=()=>({retainContentCache:(_key,create)=>({cache:create(),release(){}}),
  data:{scope:[]},
  retainScopeState:()=>({state,release:()=>{}}),
  scopeReconnectVersion:()=>generation,
  capturePartSnapshotRequest:()=>({}),
  captureResourceRequest:()=>({}),
  beginContextProjection:()=>0,
  partSnapshotAction:()=>'apply',
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
let generation=0;export const setGeneration=value=>{generation=value};
let historyIds;export const setHistoryPage=value=>{historyIds=value};
let ids=['root-old','answer-old','injection'];
export const setPage = value => {ids=value};
const page=(input)=>({data:{items:(input.messageID?(historyIds??ids):ids).map((id,index)=>({info:{id,sessionID:'ses_probe',role:'user',time:{created:index}},parts:[{id:'part-'+id,type:'text',text:'fixture'}]})),referencedRoots:[],nextCursor:null,hasMore:false,total:ids.length},response:{headers:{get:()=>null}}});
export const useSDK=()=>({scopeKey:'probe',scopeID:'home',directory:'/probe',isHome:true,client:{
  permission:{list:(input)=>{calls.permissionList.push(input);return Promise.resolve({data:[]})}},
  session:{
    get:()=>Promise.resolve({data:{id:'ses_probe',time:{created:0,updated:0}}}),
    inbox:()=>Promise.resolve({data:[]}),
    partPage:()=>Promise.resolve({data:{items:[],nextCursor:null,hasMore:false,previousCursor:null,hasEarlier:false}}),
    timelinePage:(input)=>{
      calls.messagePage.push({sessionID:input.sessionID,limit:input.limit,...(input.cursor?{cursor:input.cursor}:{})});
      return Promise.resolve(page(input));
    },
  },
}});
`,
  )
  await Bun.write(
    entry,
    `
import {render} from 'solid-js/web';import {SyncProvider,useSync} from ${JSON.stringify(sync)};import {calls,setPage,setGeneration,setHistoryPage} from ${JSON.stringify(stub)};
let api;function Child(){api=useSync();return <div>probe</div>}
const dispose=render(()=><SyncProvider><Child/></SyncProvider>,document.getElementById('root'));
export const harness={calls,dispose,run:async()=>{
  const snapshots=[];
  const snapshot=()=>snapshots.push({messages:api.data.message.ses_probe.map(m=>m.id),parts:Object.keys(api.data.part).sort()});
  await api.session.sync('ses_probe');snapshot();
  setPage(['root-retry','answer-retry']);
  await api.session.sync('ses_probe',{trigger:{type:'history-transition'}});snapshot();
  setPage(['injection','root-new']);
  await api.session.sync('ses_probe',{trigger:{type:'history-transition'}});snapshot();
  setPage(['root-retry','answer-retry']);
  await api.session.sync('ses_probe',{trigger:{type:'history-transition'}});snapshot();
  setPage(['older-root','older-answer']);
  await api.session.history.locate('ses_probe','older-root');
  setHistoryPage(['older-root','older-answer']);
  setPage(['latest-root','latest-answer']);
  setGeneration(1);
  await api.session.sync('ses_probe');
  if(api.session.history.mode('ses_probe')!=='history') throw new Error('Recovery discarded history mode');
  snapshot();
  return snapshots;
}};
`,
  )
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
  let harness: Harness | undefined
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
    harness = ((await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)) as { harness: Harness }).harness
    expect(await harness.run()).toEqual([
      { messages: ["root-old", "answer-old", "injection"], parts: ["answer-old", "injection", "root-old"] },
      { messages: ["root-retry", "answer-retry"], parts: ["answer-retry", "root-retry"] },
      { messages: ["injection", "root-new"], parts: ["injection", "root-new"] },
      { messages: ["root-retry", "answer-retry"], parts: ["answer-retry", "root-retry"] },
      { messages: ["older-root", "older-answer"], parts: ["older-answer", "older-root"] },
    ])
    expect(harness.calls.messagePage).toHaveLength(7)
  } finally {
    harness?.dispose()
    root.remove()
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
