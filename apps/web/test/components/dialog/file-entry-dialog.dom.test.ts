import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".file-entry-dialog-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    const h=window.fixture={calls:[],fail:true}
    export const actions={
      async createFile(path){h.calls.push({kind:"createFile",path}); if(h.fail)throw {data:{message:"Workspace is busy"}}},
      async createDirectory(path){h.calls.push({kind:"createDirectory",path})},
      async move(input){h.calls.push({kind:"move",...input}); if(h.fail)throw {data:{message:"Workspace is busy"}}},
      async copy(input){h.calls.push({kind:"copy",...input})},
      async remove(input){h.calls.push({kind:"remove",...input}); if(h.fail)throw {data:{message:"Workspace is busy"}}},
    }

  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><html style="overflow:hidden"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {FileDeleteDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/file-workbench/entry-dialog.tsx`)}
    import {FileCloseDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/file-workbench/close-dialog.tsx`)}
    import {actions} from "./stubs"
    import {MetaProvider} from "@solidjs/meta"
    import {Font} from "@ericsanchezok/synergy-ui/font"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
    const i18n=setupI18n({locale:"en",messages:{en:{},"zh-CN":{"app.fileEntries.title":"文件操作","app.fileEntries.operation":"操作","app.fileEntries.move":"移动或重命名","app.fileEntries.remove":"永久删除","app.fileEntries.apply":"执行","app.fileEntries.cancel":"取消"}}})
    window.fixture.locale=()=>i18n.activate("zh-CN")
    window.fixture.closeResults=[]
    function App(){
      const dialog=useDialog()
      async function leave(){
        const choice=await new Promise(resolve=>{
          let id
          id=dialog.push(
            ()=><FileCloseDialog name="draft.txt" choose={choice=>{resolve(choice);dialog.close(id)}}/>,
            ()=>resolve("cancel"),
            {protected:true},
          )
        })
        window.fixture.closeResults.push(choice)
      }
      return <>
        <button id="open" onClick={()=>dialog.show(()=><FileDeleteDialog actions={actions} workspacePath="/workspace" node={{path:"folder/source.txt",entryVersion:"entry:observed",type:"file",name:"source.txt"}} dirty={true}/>)}>Open</button>
        <button id="create" onClick={()=>dialog.show(()=><FileDeleteDialog actions={actions} workspacePath="/workspace" node={{path:"unknown.txt",type:"file",name:"unknown.txt"}}/>)}>Unavailable entry</button>
        <button id="leave" onClick={leave}>Leave file</button>
      </>
    }
    render(()=><MetaProvider><Font/><ThemeProvider><I18nProvider i18n={i18n}><DialogProvider><App/></DialogProvider></I18nProvider></ThemeProvider></MetaProvider>,document.getElementById("root"))

  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid(), tailwind()],
    resolve: { alias: { "@": appSrc } },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("delete retains the captured entry version and errors until success", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "Workspace is busy" }).waitFor()
  expect(await page.getByText("folder/source.txt", { exact: true }).isVisible()).toBe(true)
  await page.evaluate(() => {
    Reflect.get(window, "fixture").fail = false
  })
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  const calls = await page.evaluate(() => Reflect.get(window, "fixture").calls)
  expect(calls).toEqual([
    { kind: "remove", path: "folder/source.txt", expectedVersion: "entry:observed", recursive: false },
    { kind: "remove", path: "folder/source.txt", expectedVersion: "entry:observed", recursive: false },
  ])
  await page.waitForFunction(() => document.activeElement?.id === "open")
  expect(errors).toEqual([])
}, 30_000)

test("delete is explicit, localized and preserves the selected filesystem identity", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "fixture")
    fixture.fail = false
    fixture.locale()
  })
  await page.getByRole("dialog", { name: "永久删除" }).waitFor()
  expect(await page.getByText("folder/source.txt", { exact: false }).count()).toBeGreaterThan(0)
  await page.getByRole("button", { name: "永久删除", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([
    { kind: "remove", path: "folder/source.txt", expectedVersion: "entry:observed", recursive: false },
  ])
  expect(errors).toEqual([])
}, 30_000)

test("delete requires an observed entry version and exposes no operation selector", async () => {
  errors.length = 0
  await page.goto(base)
  await page.locator("#create").click()
  const dialog = page.getByRole("dialog", { name: "Delete permanently", exact: true })
  await page.waitForFunction((element) => element?.contains(document.activeElement), await dialog.elementHandle())
  expect(await dialog.getByRole("button", { name: "Delete permanently", exact: true }).isDisabled()).toBe(true)
  expect(await dialog.getByText("Refresh the file list before changing this entry.", { exact: true }).isVisible()).toBe(
    true,
  )
  expect(await dialog.getByRole("combobox").count()).toBe(0)
  expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([])
  expect(errors).toEqual([])
}, 30_000)

interface FileCloseFixtureWindow extends Window {
  fixture: { closeResults: Array<"save" | "discard" | "cancel"> }
}

test("save, discard and cancel return one choice and restore file-control focus", async () => {
  errors.length = 0
  await page.goto(base)
  const results: FileCloseFixtureWindow["fixture"]["closeResults"] = []
  for (const choice of ["save", "discard", "cancel"] as const) {
    await page.getByRole("button", { name: "Leave file", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Save changes?", exact: true })
    await dialog.waitFor()
    expect(await dialog.getAttribute("aria-describedby")).toBeTruthy()
    expect(await dialog.innerText()).toContain("Save changes to draft.txt before leaving this file.")
    await dialog.getByRole("button", { name: new RegExp("^" + choice + "$", "i") }).click()
    await dialog.waitFor({ state: "hidden" })
    results.push(choice)
    expect(await page.evaluate(() => (window as unknown as FileCloseFixtureWindow).fixture.closeResults)).toEqual(
      results,
    )
    await page.waitForFunction(() => document.activeElement?.id === "leave")
  }
  expect(errors).toEqual([])
}, 30_000)

test("Escape and the close button cancel the file change without selecting save or discard", async () => {
  errors.length = 0
  await page.goto(base)
  for (const action of ["escape", "close"]) {
    await page.getByRole("button", { name: "Leave file", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Save changes?", exact: true })
    await dialog.waitFor()
    if (action === "escape") await page.keyboard.press("Escape")
    else await dialog.getByRole("button", { name: "Close dialog", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.id === "leave")
  }
  expect(await page.evaluate(() => (window as unknown as FileCloseFixtureWindow).fixture.closeResults)).toEqual([
    "cancel",
    "cancel",
  ])
  expect(errors).toEqual([])
}, 30_000)
