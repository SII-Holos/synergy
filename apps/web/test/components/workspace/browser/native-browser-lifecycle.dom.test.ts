import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { createBrowserFixture } from "../../../support/browser-fixture"

test("a retained native surface hides for overlays and detaches while its session is inactive", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".native-lifetime-"))
  const native = path.resolve(
    import.meta.dir,
    "../../../../src/components/workspace/browser/native-browser-surface.tsx",
  )
  const stub = path.join(directory, "stub.ts")
  await Bun.write(
    stub,
    `
    import {createSignal} from 'solid-js'
    export const [active,setActive]=createSignal(true),[overlay,setOverlay]=createSignal(false)
    export const calls=[]
    const page={id:'page',url:'https://example.test'}
    const browser={presentation:()=>({kind:'native'}),page:()=>page,pageId:()=>page.id,hostStatus:()=>'ready',fileChooserRequest:()=>null,dialogRequest:()=>null,controlsOpen:()=>false,addressSuggestionsOpen:()=>false,browserError:()=>null,annotationTarget:()=>null,viewportWidth:()=>800,viewportHeight:()=>600,setBrowserError(){}}
    export const useBrowser=()=>browser
    export const useDialog=()=>({get active(){return overlay()}})
    export const usePlatform=()=>({browserNative:{attachView:async input=>{calls.push(['attach',input.visible])},resizeView:async()=>{},detachView:async()=>{calls.push(['detach'])}}})
  `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from 'solid-js/web'
    import {NativeBrowserSurface} from ${JSON.stringify(native)}
    import {ViewActivityProvider} from '@/context/view-residency'
    import {WorkbenchSurfaceOverlay} from '@/components/workspace/workbench-surface-overlay'
    import {createSignal} from 'solid-js'
    import {active,setActive,setOverlay,calls} from './stub'
    const [menu,setMenu]=createSignal(false)
    const container=document.createElement('div');container.style.cssText='width:0;height:0';document.body.append(container)
    window.fixture={setActive,setOverlay,setMenu,calls,setSize:shown=>container.style.cssText=shown?'width:800px;height:600px':'width:0;height:0'}
    render(()=><ViewActivityProvider active={active}><WorkbenchSurfaceOverlay.Provider value={menu}><NativeBrowserSurface container={()=>container} ownerKey="scope"/></WorkbenchSurfaceOverlay.Provider></ViewActivityProvider>,document.getElementById('root'))
  `,
  )
  const server = await createBrowserFixture({
    root: directory,
    aliases: [
      { find: "./browser-store", replacement: stub },
      { find: "@/context/platform", replacement: stub },
      { find: "@ericsanchezok/synergy-ui/context/dialog", replacement: stub },
      { find: "@", replacement: path.resolve(import.meta.dir, "../../../../src") },
    ],
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => console.error(error))
    await page.goto(server.url)
    const act = async (method: string, value: boolean) =>
      page.evaluate(
        ({ method, value }) => {
          ;(window as unknown as { fixture: Record<string, (value: boolean) => void> }).fixture[method](value)
        },
        { method, value },
      )
    const calls = () => page.evaluate(() => (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls)
    await page.waitForFunction(() => Boolean((window as unknown as { fixture?: unknown }).fixture))
    expect(await calls()).toEqual([])
    await act("setSize", true)
    await page.waitForFunction(
      () => (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.length > 0,
    )
    await act("setOverlay", true)
    await page.waitForTimeout(20)
    expect((await calls()).at(-1)).toEqual(["attach", false])
    await act("setOverlay", false)
    await page.waitForTimeout(20)
    expect((await calls()).at(-1)).toEqual(["attach", true])
    await act("setMenu", true)
    await page.waitForTimeout(20)
    expect((await calls()).at(-1)).toEqual(["attach", false])
    await act("setActive", false)
    await page.waitForTimeout(20)
    expect((await calls()).at(-1)).toEqual(["detach"])
    const inactiveCalls = (await calls()).length
    await act("setMenu", false)
    await act("setOverlay", true)
    await act("setOverlay", false)
    await page.waitForTimeout(20)
    expect((await calls()).length).toBe(inactiveCalls)
    await act("setActive", true)
    await page.waitForTimeout(20)
    expect((await calls()).at(-1)).toEqual(["attach", true])
  } finally {
    await browser.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)

test("native covers keep the newest image and discard failed or inactive captures", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".native-cover-"))
  const native = path.resolve(
    import.meta.dir,
    "../../../../src/components/workspace/browser/native-browser-surface.tsx",
  )
  const stub = path.join(directory, "stub.ts")
  await Bun.write(
    stub,
    `
    import {createSignal} from 'solid-js'
    export const [active,setActive]=createSignal(true)
    export const [hostReady,setHostReady]=createSignal(false)
    export const [overlay,setOverlay]=createSignal(false)
    export const [page,setPage]=createSignal({id:'page',url:'https://example.test',status:'active',isLoading:false})
    export const calls=[],pending=[]
    let listener
    export const emit=event=>listener?.({...event,pageId:page().id,protocolVersion:8})
    export const useBrowser=()=>({presentation:()=>({kind:'native'}),page,pageId:()=>page().id,hostStatus:()=>hostReady()?'ready':'connecting',fileChooserRequest:()=>null,dialogRequest:()=>null,controlsOpen:()=>false,addressSuggestionsOpen:()=>false,browserError:()=>null,annotationTarget:()=>null,setBrowserError(){}})
    export const useDialog=()=>({active:false})
    export const usePlatform=()=>({browserNative:{
      attachView:async input=>calls.push(input),resizeView:async()=>{},detachView:async()=>{},
      onEvent:fn=>{listener=fn;return ()=>{listener=undefined}},
      pageAction:input=>new Promise(resolve=>pending.push({input,resolve}))
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from 'solid-js/web'
    import {NativeBrowserSurface} from ${JSON.stringify(native)}
    import {ViewActivityProvider} from '@/context/view-residency'
    import {active,setActive,setHostReady,overlay,setOverlay,page,setPage,emit,pending,calls} from './stub'
    import {WorkbenchSurfaceOverlay} from '@/components/workspace/workbench-surface-overlay'
    const container=document.getElementById('root');container.style.cssText='width:800px;height:600px;position:relative'
    const image=color=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,2,2);return canvas.toDataURL('image/png')}
    window.fixture={setActive,setHostReady,setOverlay,setPage,pending,calls,emit,old:image('red'),fresh:image('blue'),
      resolve:(index,dataUrl)=>pending[index].resolve({type:'cover',url:page().url,dataUrl})}
    render(()=><ViewActivityProvider active={active}><WorkbenchSurfaceOverlay.Provider value={overlay}><NativeBrowserSurface container={()=>container} ownerKey="scope"/></WorkbenchSurfaceOverlay.Provider></ViewActivityProvider>,container)
  `,
  )
  const server = await createBrowserFixture({
    root: directory,
    aliases: [
      { find: "./browser-store", replacement: stub },
      { find: "@/context/platform", replacement: stub },
      { find: "@ericsanchezok/synergy-ui/context/dialog", replacement: stub },
      { find: "@", replacement: path.resolve(import.meta.dir, "../../../../src") },
    ],
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "fixture")
      fixture.setHostReady(true)
      fixture.setOverlay(true)
    })
    await page.waitForFunction(() => Reflect.get(window, "fixture")?.pending.length === 1)
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls.at(-1)?.visible)).toBe(true)
    const fresh = await page.evaluate(() => {
      const f = Reflect.get(window, "fixture")
      f.resolve(0, f.fresh)
      return f.fresh as string
    })
    await page.waitForTimeout(80)
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls.at(-1)?.visible)).toBe(false)
    expect(await page.locator("#root img").getAttribute("src")).toBe(fresh)
    await page.evaluate(() => Reflect.get(window, "fixture").setOverlay(false))
    await page.evaluate(() =>
      Reflect.get(window, "fixture").setPage({ id: "invalid", url: "https://invalid.test", status: "active" }),
    )
    await page.waitForFunction(() => Reflect.get(window, "fixture").pending.length === 2)
    await page.evaluate(() => Reflect.get(window, "fixture").resolve(1, "data:image/jpeg;base64,broken"))
    await page.waitForTimeout(80)
    expect(await page.locator("#root img").count()).toBe(0)
    await page.evaluate(() =>
      Reflect.get(window, "fixture").setPage({ id: "inactive", url: "https://inactive.test", status: "active" }),
    )
    await page.waitForFunction(() => Reflect.get(window, "fixture").pending.length === 3)
    await page.evaluate(() => {
      const f = Reflect.get(window, "fixture")
      f.setActive(false)
      f.resolve(2, f.old)
    })
    await page.waitForTimeout(80)
    expect(await page.locator("#root img").count()).toBe(0)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => Reflect.get(window, "fixture").pending.length)).toBe(3)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
