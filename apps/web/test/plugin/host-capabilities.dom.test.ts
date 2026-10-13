import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

type Control = {
  features(value?: string[]): void
  scope(value: string): void
  resolve(index: number): void
  requests(): boolean[]
}
let directory: string
let fixture: BrowserFixture
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".host-capabilities-"))
  const source = path.resolve(import.meta.dir, "../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    const [selection,setSelection]=createSignal({features:["plugin-host"]})
    export const [scope,setScope]=createSignal("a")
    const requests=[]
    window.fixture={features:value=>setSelection(value?{features:value}:undefined),scope:setScope,
      requests:()=>requests.map(request=>request.signal.aborted),
      resolve(index){const request=requests[index];request.resolve([{pluginId:"fixture",name:"Fixture",version:"1.0",generation:"one",scopeId:request.scope,capabilities:[],contributions:[]}])}}
    export const fetchUIContributions=(server,scope,signal)=>new Promise(resolve=>requests.push({server,scope,signal,resolve}))
    export const useGlobalSDK=()=>({client:{},connected:()=>true,capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false},event:{listen:()=>()=>{}}})
    export const useServer=()=>({url:"server"})
    export const normalizeServerUrl=value=>value
    export const serverDisplayName=value=>value
    export const useCommand=()=>({register:()=>()=>{},trigger(){},options:[]})
    export const useWorkbenchPanels=()=>({})
    export const createPluginEnvironment=()=>({environment:{},resources:{}})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { PluginHostProvider,usePluginHost } from "@/plugin/host"
    import { scope } from "./services"
    function Contents(){const host=usePluginHost();return <><output data-scope-a>{host.scopeGeneration("a")}</output><output data-scope-b>{host.scopeGeneration("b")}</output><output data-loaded>{host.loadedPluginIds().join(",")}</output></>}
    render(()=><PluginHostProvider scopeKey={scope}><Contents/></PluginHostProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  fixture = await createBrowserFixture({
    root: directory,
    localized: true,
    aliases: [
      ...[
        "@/context/global-sdk",
        "@/context/server",
        "@/context/command",
        "@/context/workbench",
        "./api",
        "./environment",
      ].map((find) => ({
        find: new RegExp(`^${find.replaceAll(".", "\\.")}$`),
        replacement: services,
      })),
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

test("plugin Scope generations survive ordinary navigation and clear on capability epoch loss", async () => {
  await page.goto(fixture.url)
  const a = page.locator("[data-scope-a]")
  const b = page.locator("[data-scope-b]")
  await page.waitForFunction(() => (window as unknown as { fixture: Control }).fixture.requests().length === 1)
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.resolve(0))
  await page.waitForFunction(() => document.querySelector("[data-loaded]")?.textContent === "fixture")
  const generation = await a.textContent()
  expect(generation).not.toBe("[]")
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.scope("b"))
  expect(await a.textContent()).toBe(generation)
  await page.waitForFunction(() => (window as unknown as { fixture: Control }).fixture.requests().length === 2)
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.features())
  expect(await a.textContent()).toBe("[]")
  expect(await b.textContent()).toBe("[]")
  expect(await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.requests())).toEqual([
    true,
    true,
  ])
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.resolve(1))
  expect(await b.textContent()).toBe("[]")
  expect(await page.locator("[data-loaded]").textContent()).toBe("")
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.features(["plugin-host"]))
  await page.waitForFunction(() => (window as unknown as { fixture: Control }).fixture.requests().length === 3)
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.resolve(2))
  await page.waitForFunction(() => document.querySelector("[data-loaded]")?.textContent === "fixture")
  expect(await b.textContent()).not.toBe("[]")
  expect(await a.textContent()).toBe("[]")
  await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.features(["plugin-host"]))
  expect(await b.textContent()).toBe("[]")
  await page.waitForFunction(() => (window as unknown as { fixture: Control }).fixture.requests().length === 4)
  expect(await page.evaluate(() => (window as unknown as { fixture: Control }).fixture.requests())).toEqual([
    true,
    true,
    true,
    false,
  ])
  expect(errors).toEqual([])
})
