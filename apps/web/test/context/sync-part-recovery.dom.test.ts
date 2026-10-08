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
  await Bun.write(
    stub,
    `
import {createStore} from 'solid-js/store';
import {createContentBudget,contentBudgetKey} from ${JSON.stringify(budget)};
import {partSummaryPageState} from ${JSON.stringify(summaries)};
const summary=id=>({id,sessionID:'session',messageID:'message',type:'text',preview:id,content:{version:'one',bytes:32}});
const page=items=>({items,nextCursor:null,previousCursor:null,hasMore:false,hasEarlier:false});
const contentBudget=createContentBudget();
const state=createStore({status:'ready',session:[],path:{directory:''},partSummary:{message:[summary('a'),summary('b')]},partPage:{message:{...partSummaryPageState(page([summary('a'),summary('b')])),stale:true}},part:{message:[{id:'b',messageID:'message',sessionID:'session',type:'text',text:'seeded body'}]},partVersion:{b:'one'}});
contentBudget.publish(contentBudgetKey('probe','message','b'),'one',64,()=>{});
export const snapshot=()=>({bytes:contentBudget.bytes,parts:state[0].part.message.map(part=>part.id),versions:Object.keys(state[0].partVersion),summaries:state[0].partSummary.message.map(part=>part.id)});
export const useGlobalSync=()=>({contentBudget,retainContentCache:(_key,create)=>{const cache=create();return {cache,release:()=>cache.dispose()}},retainScopeState:()=>({state,release:()=>{}}),peekScopeState:()=>state,capturePartSnapshotRequest:()=>({}),partSnapshotAction:()=>'apply'});
export const refreshPlanBlueprintOfferFromLoadedParts=()=>{};
export const updatePlanBlueprintOfferState=()=>{};
export const useSDK=()=>({scopeKey:'probe',client:{session:{partPage:()=>Promise.resolve({data:page([summary('a')])})}}});
`,
  )
  await Bun.write(
    entry,
    `
import {render} from 'solid-js/web';
import {SyncProvider,useSync} from ${JSON.stringify(sync)};
import {snapshot} from ${JSON.stringify(stub)};
let api;
function Child(){api=useSync();return <div>probe</div>}
const dispose=render(()=><SyncProvider><Child/></SyncProvider>,document.getElementById('root'));
export const harness={snapshot,dispose,run:()=>api.session.content.summaries('session','message')};
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
        dispose(): void
      }
    }
    expect(harness.snapshot()).toEqual({ bytes: 64, parts: ["b"], versions: ["b"], summaries: ["a", "b"] })
    try {
      await harness.run()
      expect(harness.snapshot()).toEqual({ bytes: 0, parts: [], versions: [], summaries: ["a"] })
    } finally {
      harness.dispose()
    }
  } finally {
    root.remove()
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
