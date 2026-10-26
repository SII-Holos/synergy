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
      async remove(input){h.calls.push({kind:"remove",...input})},
    }

  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {FileEntryDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/file-workbench/entry-dialog.tsx`)}
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
        <button id="open" onClick={()=>dialog.show(()=><FileEntryDialog actions={actions} workspacePath="/workspace" node={{path:"folder/source.txt",entryVersion:"entry:observed",type:"file",name:"source.txt"}} operation="move" dirty={true}/>)}>Open</button>
        <button id="create" onClick={()=>dialog.show(()=><FileEntryDialog actions={actions} workspacePath="/workspace"/>)}>Create entry</button>
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

async function open() {
  errors.length = 0
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByRole("button", { name: "/first", exact: true }).waitFor()
  expect(errors).toEqual([])
}

test("entry actions retain captured versions, errors and entered paths until success", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByLabel("Path within Workspace").fill("folder/renamed.txt")
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "Workspace is busy" }).waitFor()
  expect(await page.getByLabel("Path within Workspace").inputValue()).toBe("folder/renamed.txt")
  await page.evaluate(() => {
    ;(window as any).fixture.fail = false
  })
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  const calls = await page.evaluate(() => (window as any).fixture.calls)
  expect(calls).toEqual([
    { kind: "move", from: "folder/source.txt", to: "folder/renamed.txt", expectedVersion: "entry:observed" },
    { kind: "move", from: "folder/source.txt", to: "folder/renamed.txt", expectedVersion: "entry:observed" },
  ])
  await page.waitForFunction(() => document.activeElement?.id === "open")
  expect(errors).toEqual([])
}, 30_000)

test("delete is explicit, localized and preserves the selected filesystem identity", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByRole("button", { name: "Operation: Move or rename", exact: true }).click()
  await page.getByRole("option", { name: "Delete permanently", exact: true }).click()
  await page.evaluate(() => (window as any).fixture.locale())
  await page.getByRole("dialog", { name: "文件操作" }).waitFor()
  expect(await page.getByText("folder/source.txt", { exact: false }).count()).toBeGreaterThan(0)
  await page.getByRole("button", { name: "永久删除", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([
    { kind: "remove", path: "folder/source.txt", expectedVersion: "entry:observed", recursive: false },
  ])
  expect(errors).toEqual([])
}, 30_000)

test("operation menu stays in its dialog, dismisses before the dialog and disables source-only actions", async () => {
  errors.length = 0
  await page.goto(base)
  await page.locator("#create").click()
  const dialog = page.getByRole("dialog", { name: "File actions", exact: true })
  await page.waitForFunction((element) => element?.contains(document.activeElement), await dialog.elementHandle())
  const trigger = page.getByRole("button", { name: "Operation: New file", exact: true })
  await trigger.press("ArrowDown")
  const listbox = page.getByRole("listbox", { name: "Operation", exact: true })
  await listbox.waitFor()
  expect(await listbox.getByRole("option").count()).toBe(5)
  for (const name of ["Move or rename", "Copy", "Delete permanently"]) {
    expect(await listbox.getByRole("option", { name, exact: true }).getAttribute("aria-disabled")).toBe("true")
  }
  const colors: string[] = []
  await page.locator(".menu-field-surface").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
    await document.fonts.ready
  })
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
    const appearance = await page.locator(".menu-field-surface").evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        background: getComputedStyle(element).backgroundColor,
        fits: bounds.x >= 0 && bounds.right <= innerWidth && bounds.y >= 0 && bounds.bottom <= innerHeight,
      }
    })
    expect(appearance.fits).toBe(true)
    colors.push(appearance.background)
  }
  expect(colors[0]).not.toBe(colors[1])
  await page.waitForFunction(
    (element) => document.activeElement === element,
    await listbox.getByRole("option", { name: "New file", exact: true }).elementHandle(),
  )
  await page.keyboard.press("ArrowDown")
  expect(await listbox.getByRole("option", { name: "New folder", exact: true }).getAttribute("data-highlighted")).toBe(
    "",
  )
  await page.keyboard.press("Escape")
  await listbox.waitFor({ state: "hidden" })
  expect(await dialog.isVisible()).toBe(true)
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Operation: New file")
  await trigger.click()
  await listbox.getByRole("option", { name: "New folder", exact: true }).click()
  await page.getByLabel("Path within Workspace").fill("created-folder")
  await dialog.getByRole("button", { name: "Apply", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as { fixture?: { calls: unknown[] } }).fixture?.calls)).toEqual([
    { kind: "createDirectory", path: "created-folder" },
  ])
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
