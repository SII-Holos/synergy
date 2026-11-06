import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

test("CommandProvider unregisters disposed pages across nested transitions", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".command-memory-"))
  const entry = path.join(dir, "main.tsx")
  const command = path.resolve(import.meta.dir, "../../src/context/command.tsx")
  const helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  const stub = path.join(dir, "stub.tsx")
  await Bun.write(
    stub,
    "export const useDialog=()=>({active:false,show(){globalThis.commandPaletteShows=(globalThis.commandPaletteShows??0)+1}}); export const Dialog=()=>null; export const List=()=>null; export const useLocale=()=>({i18n:{_:x=>x}}); export const AP={};",
  )
  await Bun.write(
    entry,
    `
import {createSignal, createResource, Suspense, Show, startTransition, onCleanup} from "solid-js";
import {render} from "solid-js/web";
import {CommandProvider,useCommand,parseKeybind} from ${JSON.stringify(command)};
let api,setPage,setTitle,release,started,cleaned=[];
let ready;const entered=new Promise(resolve=>ready=resolve);
const [title,updateTitle]=createSignal("Page");setTitle=updateTitle;
function Page(props){api.register(()=>[{id:'page.'+props.id,title:title()+' '+props.id},{id:'shared',title:'Shared '+props.id}]);onCleanup(()=>cleaned.push(props.id));const [resource]=createResource(()=>props.id===102?new Promise(resolve=>{release=()=>resolve('ready');ready()}):'ready');return <div>{resource()}{props.id}</div>}
function Probe(){api=useCommand();const [page,set]=createSignal(1);setPage=set;return <><textarea data-terminal on:keydown={event=>{globalThis.terminalKeys=(globalThis.terminalKeys??0)+1;event.preventDefault()}}/><Suspense><Show when={page()} keyed>{id=><Show when={true}><Page id={id}/></Show>}</Show></Suspense></>}
const dispose=render(()=><CommandProvider><Probe/></CommandProvider>,document.getElementById('root'));
globalThis.commandMemoryProbe={step:id=>startTransition(()=>setPage(id)),options:()=>api.options.map(x=>({id:x.id,title:x.title})),entered,setTitle,release:()=>release(),cleaned,dispose,palette:()=>{const keybind=parseKeybind('mod+shift+p')[0];const event=new KeyboardEvent('keydown',{key:'P',ctrlKey:keybind.ctrl,metaKey:keybind.meta,shiftKey:true,bubbles:true,cancelable:true});(document.querySelector('[data-terminal]')??document.body).dispatchEvent(event);return {shown:globalThis.commandPaletteShows??0,terminalKeys:globalThis.terminalKeys??0,prevented:event.defaultPrevented}}};
`,
  )

  try {
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: [
          { find: /^@ericsanchezok\/synergy-ui\/context$/, replacement: helper },
          { find: "@ericsanchezok/synergy-ui/context/dialog", replacement: stub },
          { find: "@ericsanchezok/synergy-ui/dialog", replacement: stub },
          { find: "@ericsanchezok/synergy-ui/list", replacement: stub },
          { find: "@/context/locale", replacement: stub },
          { find: "@/app-i18n", replacement: stub },
        ],
      },
      plugins: [solidPlugin()],
      build: {
        outDir: path.join(dir, "dist"),
        minify: false,
        lib: { entry, formats: ["es"], fileName: "fixture" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    const root = document.createElement("div")
    root.id = "root"
    document.body.append(root)
    await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)
    const h = (
      globalThis as unknown as {
        commandMemoryProbe: {
          step: (id: number) => Promise<void>
          options: () => { id: string; title: string }[]
          entered: Promise<void>
          setTitle: (title: string) => void
          release: () => void
          cleaned: number[]
          dispose: () => void
          palette: () => { shown: number; terminalKeys: number; prevented: boolean }
        }
      }
    ).commandMemoryProbe
    try {
      for (let i = 2; i <= 101; i++) await h.step(i)
      expect(h.cleaned.length).toBe(100)
      expect(h.options()).toEqual([
        { id: "page.101", title: "Page 101" },
        { id: "shared", title: "Shared 101" },
      ])
      h.setTitle("Renamed")
      expect(h.options()[0]?.title).toBe("Renamed 101")
      expect(h.palette()).toEqual({ shown: 1, terminalKeys: 0, prevented: true })
      const pending = h.step(102)
      await h.entered
      try {
        expect(h.options().map((x) => x.id)).toEqual(["page.101", "shared"])
      } finally {
        h.release()
        await pending
      }
      expect(h.options()).toEqual([
        { id: "page.102", title: "Renamed 102" },
        { id: "shared", title: "Shared 102" },
      ])
      expect(h.cleaned.length).toBe(101)
      h.dispose()
      expect(h.cleaned.length).toBe(102)
      expect(h.palette()).toEqual({ shown: 1, terminalKeys: 0, prevented: false })
    } finally {
      h.dispose()
      root.remove()
      delete (globalThis as { commandMemoryProbe?: unknown }).commandMemoryProbe
      delete (globalThis as { commandPaletteShows?: number }).commandPaletteShows
      delete (globalThis as { terminalKeys?: number }).terminalKeys
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
