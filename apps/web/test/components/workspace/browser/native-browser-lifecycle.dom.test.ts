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
    const browser={presentation:()=>({kind:'native'}),page:()=>page,pageId:()=>page.id,fileChooserRequest:()=>null,dialogRequest:()=>null,controlsOpen:()=>false,addressSuggestionsOpen:()=>false,browserError:()=>null,annotationTarget:()=>null,viewportWidth:()=>800,viewportHeight:()=>600,setBrowserError(){}}
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
    window.fixture={setActive,setOverlay,setMenu,calls}
    const container=document.createElement('div');container.style.cssText='width:800px;height:600px';document.body.append(container)
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
