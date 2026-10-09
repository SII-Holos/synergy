import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

test("accepted Part removal releases a seeded body budget without a materializer reader", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-part-recovery-"))
  const entry = path.join(dir, "main.tsx")
  const stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx")
  const helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  const budget = path.resolve(import.meta.dir, "../../src/context/content-budget.ts")
  const summaries = path.resolve(import.meta.dir, "../../src/context/part-summary-loader.ts")
  const contentStore = path.resolve(import.meta.dir, "../../src/context/part-content-store.ts")
  await Bun.write(
    stub,
    `
import {createStore} from 'solid-js/store';
import {createContentBudget,contentBudgetKey} from ${JSON.stringify(budget)};
import {partSummaryPageState} from ${JSON.stringify(summaries)};
import {createPartContentStore} from ${JSON.stringify(contentStore)};
const partContentStore=createPartContentStore();
export const contentCalls=[];
let finishContent;export const completeContent=()=>finishContent();
const summary=id=>({id,sessionID:'session',messageID:'message',type:'text',preview:id,content:{version:'one',bytes:32}});
const page=items=>({items,nextCursor:null,previousCursor:null,hasMore:false,hasEarlier:false});
const contentBudget=createContentBudget();
const state=createStore({status:'ready',session:[],path:{directory:''},partSummary:{message:[summary('a'),summary('b')]},partPage:{message:{...partSummaryPageState(page([summary('a'),summary('b')])),stale:true}},part:{message:[{id:'b',messageID:'message',sessionID:'session',type:'text',text:'seeded body'}]},partVersion:{b:'one'}});
contentBudget.publish(contentBudgetKey('probe','message','b'),'one',64,()=>{});
export const snapshot=()=>({bytes:contentBudget.bytes,parts:state[0].part.message.map(part=>part.id),versions:Object.keys(state[0].partVersion),summaries:state[0].partSummary.message.map(part=>part.id)});
export const useGlobalSync=()=>({contentBudget,partContentStore,retainContentCache:(_key,create)=>{const controller=new AbortController();const cache=create(controller.signal);return {cache,release:()=>{controller.abort();cache.dispose()}}},retainScopeState:()=>({state,release:()=>{}}),peekScopeState:()=>state,capturePartSnapshotRequest:()=>({}),partSnapshotAction:()=>'apply'});
export const refreshPlanBlueprintOfferFromLoadedParts=()=>{};
export const updatePlanBlueprintOfferState=()=>{};
export const useSDK=()=>({url:'http://fixture',scopeKey:'probe',content:{retain:()=>()=>{}},client:{session:{
partPage:()=>Promise.resolve({data:page([summary('a')])}),
partContent:(input,options)=>{contentCalls.push(options.signal);return new Promise(resolve=>{finishContent=()=>resolve({data:{part:{id:'a',sessionID:'session',messageID:'message',type:'text',text:'Original body'},version:input.version}})})},
}}});
`,
  )
  await Bun.write(
    entry,
    `
import {render} from 'solid-js/web';
import {SyncProvider,useSync} from ${JSON.stringify(sync)};
import {snapshot,contentCalls,completeContent} from ${JSON.stringify(stub)};
let api,peer;
function Child(){api=useSync();return <div>probe</div>}
function Peer(){peer=useSync();return <div>peer</div>}
const root=document.getElementById('root'),peerRoot=document.createElement('div');root.append(peerRoot);
const disposeMain=render(()=><SyncProvider><Child/></SyncProvider>,root);
const disposePeer=render(()=><SyncProvider><Peer/></SyncProvider>,peerRoot);
const dispose=()=>{disposePeer();disposeMain()};
export const harness={snapshot,dispose,run:()=>api.session.content.summaries('session','message'),runContent:async()=>{
  const summary=api.data.partSummary.message[0];
  const dropped=[];
  for(let index=0;index<3;index++){
    const lease=(index%2?peer:api).session.content.retain(summary);
    lease.release();dropped.push(lease.ready);
  }
  const successor=peer.session.content.retain(summary);
  await Promise.resolve();
  const reads=contentCalls.length;
  completeContent();await Promise.all([...dropped,successor.ready]);
  const text=api.data.part.message.find(part=>part.id==='a')?.text;
  successor.release();api.session.content.invalidate('message','a');
  const cached=api.session.content.retain(summary);await cached.ready;
  const restored=api.data.part.message.find(part=>part.id==='a')?.text;
  cached.release();
  return {reads,totalReads:contentCalls.length,text,restored,aborted:contentCalls[0].aborted};
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
    const { harness } = (await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)) as {
      harness: {
        snapshot(): { bytes: number; parts: string[]; versions: string[]; summaries: string[] }
        run(): Promise<void>
        runContent(): Promise<{ reads: number; totalReads: number; text: string; restored: string; aborted: boolean }>
        dispose(): void
      }
    }
    expect(harness.snapshot()).toEqual({ bytes: 64, parts: ["b"], versions: ["b"], summaries: ["a", "b"] })
    try {
      await harness.run()
      expect(harness.snapshot()).toEqual({ bytes: 0, parts: [], versions: [], summaries: ["a"] })
      expect(await harness.runContent()).toEqual({
        reads: 1,
        totalReads: 1,
        text: "Original body",
        restored: "Original body",
        aborted: false,
      })
    } finally {
      harness.dispose()
    }
  } finally {
    root.remove()
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
