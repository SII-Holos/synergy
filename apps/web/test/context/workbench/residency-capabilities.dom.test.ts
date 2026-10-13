import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

type Fixture = {
  pause(): void
  resume(): void
  features(features?: string[]): void
  generation(value: string): void
  facts(): { mounts: number; disposed: number; aborted: boolean[]; active: boolean[]; saved: number; visible: number }
}
let directory: string
let fixture: BrowserFixture
let browser: Browser
let page: Page
const errors: string[] = []
const facts = () => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.facts())

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".residency-capabilities-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    export const [selection,setSelection]=createSignal({features:["plugin-host","note","blueprint","lattice"]})
    export const [active,setActive]=createSignal(true)
    const surfaces = Object.fromEntries(["side","bottom"].map(name=>{
      const [tabs,setTabs]=createSignal(name==="side"?[{id:"plugin",panelId:"fixture:panel",title:"Plugin"}]:[])
      const [selected,setSelected]=createSignal(name==="side"?"plugin":undefined)
      const [opened,setOpened]=createSignal(name==="side")
      const [size,setSize]=createSignal(name==="side"?360:200)
      const [fullscreen,setFullscreen]=createSignal(false)
      return [name,{tabs,setTabs,active:selected,setActive:setSelected,opened,open:()=>setOpened(true),close:()=>setOpened(false),size,setSize,fullscreen,setFullscreen,reveal:()=>({interacted:false}),setReveal(){}}]
    }))
    export const saved=()=>surfaces.side.tabs().length
    export const useGlobalSDK=()=>({capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false}})
    export const useLayout=()=>({surface:(_,name)=>surfaces[name],isDesktop:()=>true,sidebar:{opened:()=>false,width:()=>260,occupiedWidth:()=>0}})
    export const useParams=()=>({dir:"scope-a",id:"session-a"})
    export const useLocale=()=>({i18n:{_:value=>value.message}})
    export const useConfirm=()=>({ask:async()=>true})
    export const useDialog=()=>({active:false})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { batch,createEffect,createSignal,onCleanup } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { WorkbenchPanelsProvider,useWorkbenchPanels } from "@/context/workbench"
    import { WorkbenchSurface } from "@/components/workspace/workbench-surface"
    import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
    import { createPluginSurfaceLifetime } from "@/plugin/surface-lifetime"
    import { ViewActivityProvider,useViewActivity } from "@/context/view-residency"
    import { active,setActive,setSelection,saved } from "./services"
    const requests=[],activities=[]
    let mounts=0,disposed=0,panels
    const [draft,setDraft]=createSignal("")
    function Panel(){
      mounts++
      const active=useViewActivity()
      const lifetime=createPluginSurfaceLifetime(error=>{throw error})
      requests.push(lifetime.context.signal)
      activities.push(lifetime.context.active)
      createEffect(()=>lifetime.setActive(active()))
      onCleanup(()=>{disposed++;lifetime.dispose()})
      return <input aria-label="Plugin draft" value={draft()} onInput={event=>setDraft(event.currentTarget.value)}/>
    }
    let generation="one"
    let release=()=>{}
    const register=()=>{release();release=registerWorkbenchPanel({id:"fixture:panel",pluginId:"fixture",retention:"pause",generation,component:Panel,label:"Plugin",icon:"file",surface:"side",cardinality:"multi"})}
    register()
    window.fixture={
      pause(){batch(()=>{setActive(false);release()})},
      resume(){batch(()=>{register();setActive(true)})},
      features:features=>setSelection(features?{features}:undefined),
      generation(value){generation=value;register()},
      facts:()=>({mounts,disposed,aborted:requests.map(signal=>signal.aborted),active:activities.map(read=>read()),saved:saved(),visible:panels.surface("side").tabs().length})
    }
    function Content(){panels=useWorkbenchPanels();return <div style="width:1000px;height:600px;display:flex"><WorkbenchSurface surface="side"/></div>}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><ViewActivityProvider active={active}><WorkbenchPanelsProvider><Content/></WorkbenchPanelsProvider></ViewActivityProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  fixture = await createBrowserFixture({
    root: directory,
    aliases: [
      ...[
        "@/context/session-route",
        "@/context/global-sdk",
        "@/context/layout",
        "@/context/locale",
        "@/components/dialog/confirm-dialog",
        "@ericsanchezok/synergy-ui/context/dialog",
        "../layout",
      ].map((find) => ({ find: new RegExp(`^${find.replaceAll(".", "\\.")}$`), replacement: services })),
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("inactive Scope registration changes preserve the paused plugin instance and lifetime", async () => {
  await page.goto(fixture.url)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Retained draft")
  const original = await input.elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.pause())
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 0, aborted: [false], active: [false], saved: 1 })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resume())
  expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(await input.inputValue()).toBe("Retained draft")
  expect(await facts()).toMatchObject({ mounts: 1, aborted: [false], active: [true] })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.generation("two"))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  expect(await facts()).toMatchObject({ mounts: 2, disposed: 1, aborted: [true, false] })
  expect(errors).toEqual([])
})

for (const [state, features] of [
  ["unknown", undefined],
  ["missing", []],
  ["replaced", ["plugin-host"]],
] as Array<[string, string[] | undefined]>)
  test(`a ${state} owner disposes paused plugin work while retaining stored drafts`, async () => {
    await page.goto(fixture.url)
    const input = page.getByRole("textbox", { name: "Plugin draft" })
    await input.fill("Preserved through absence")
    const original = await input.elementHandle()
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.pause())
    await page.evaluate((features) => (window as unknown as { fixture: Fixture }).fixture.features(features), features)
    expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
    expect(await facts()).toMatchObject({ mounts: 1, disposed: 1, aborted: [true], saved: 1, visible: 0 })
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: Fixture }).fixture
      fixture.features(["plugin-host"])
      fixture.resume()
    })
    await input.waitFor()
    expect(await input.inputValue()).toBe("Preserved through absence")
    expect(await facts()).toMatchObject({ mounts: 2, aborted: [true, false], saved: 1, visible: 1 })
    expect(errors).toEqual([])
  })

test("capability loss removes an active plugin even before its registry entry is released", async () => {
  await page.goto(fixture.url)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Active draft")
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 1, aborted: [true], saved: 1, visible: 0 })
  expect(await input.count()).toBe(0)
  expect(errors).toEqual([])
})
