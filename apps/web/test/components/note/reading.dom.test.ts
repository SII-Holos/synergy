import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

let browser: Browser
let page: Page
let server: PreviewServer
let directory: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-note-reading-")))
  await symlink(path.resolve(source, "../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {useLingui} from "@lingui/solid"
    const plain=new URLSearchParams(location.search).has("plain")
    const paragraph=text=>({type:"paragraph",content:[{type:"text",text}]})
    let note={id:"reading",scopeID:"home",title:"Blueprint: 阅读和编辑的连续性",kind:plain?"note":"blueprint",version:1,tags:["reading"],pinned:false,global:false,archived:false,time:{created:1,updated:1},content:{type:"doc",content:[
      ...(plain?[]:[{type:"heading",attrs:{level:1},content:[{type:"text",text:"Blueprint: 阅读和编辑的连续性"}]}]),
      ...Array.from({length:35},(_,i)=>paragraph("第 "+i+" 段：保留阅读位置与编辑状态。 Comfortable reading keeps the document visible while metadata changes.")),
      {type:"codeBlock",attrs:{language:"text"},content:[{type:"text",text:"long_source_identifier_".repeat(40)}]},
      {type:"table",content:[{type:"tableRow",content:Array.from({length:8},()=>({type:"tableCell",content:[paragraph("Wide table content")] }))}]}
    ]}}
    const listeners=new Set(),writes=[],tabs=[]
    const emit=()=>listeners.forEach(fn=>fn({name:"home",details:{type:"note.updated",properties:{scopeID:"home",note,meta:note,changed:["title"]}}}))
    const sdk={url:"http://fixture.test",capabilities:{has:id=>["note","blueprint"].includes(id),current:()=>({features:["note","blueprint"]})},event:{listen:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}},client:{note:{get:async()=>({data:note}),listMeta:async()=>({data:[{scopeID:"home",scopeType:"home",notes:[note]}]}),update:async({notePatchInput})=>{writes.push(notePatchInput);note={...note,...notePatchInput,version:note.version+1};emit();return {data:note}}},blueprint:{loop:{list:async()=>({data:[]})}}}}
    export const useGlobalSDK=()=>sdk
    export const useGlobalSync=()=>({reconnectVersion:()=>0,data:{scope:[],provider:{all:[],connected:[]}}})
    export const useSync=()=>({data:{agent:[],config:{}}})
    export const useParams=()=>({dir:"aG9tZQ"})
    export const usePlatform=()=>({platform:"web"})
    export const useLocale=()=>{const {i18n}=useLingui();return {i18n:i18n(),fmt:{relative:()=>"Today",dateTime:()=>"Today"}}}
    export const tab={id:"reading-tab",panelId:"notes",resourceId:"reading",source:"home",title:note.title,state:{kind:note.kind}}
    export const useWorkbenchPanels=()=>({sessionKey:()=>"session",surface:()=>({tabs:()=>[tab]}),updateTab:(id,patch)=>tabs.push(patch),beforeClose:()=>()=>{}})
    window.fixture={writes,tabs,note:()=>note,emit,listenerCount:()=>listeners.size}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DataProvider} from "@ericsanchezok/synergy-ui/context"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {NotePanel} from ${JSON.stringify(path.join(source, "components/note/panel.tsx"))}
    import {NoteDocumentsProvider,useNoteDocuments} from ${JSON.stringify(path.join(source, "components/note/documents.tsx"))}
    import {tab} from "./services"
    import ${JSON.stringify(path.join(source, "index.css"))}
    function Content(){const docs=useNoteDocuments();docs.navigation("home").setOpen(false);return <NotePanel tab={tab}/>}
    render(()=><ThemeProvider><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DataProvider data={{}} directory={null} serverUrl="http://fixture.test"><DialogProvider><NoteDocumentsProvider><main style="height:100dvh;overflow:hidden"><Content/></main></NoteDocumentsProvider></DialogProvider></DataProvider></I18nProvider></ThemeProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    worker: { format: "es" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: {
      alias: [
        ...["global-sdk", "global-sync", "sync", "session-route", "platform", "locale", "workbench"].map((name) => ({
          find: `@/context/${name}`,
          replacement: services,
        })),
        { find: "@", replacement: source },
      ],
    },
    build: {
      outDir: path.join(directory, "dist"),
      minify: false,
      target: "esnext",
      lib: { entry: path.join(directory, "main.tsx"), formats: ["es"], fileName: "main", cssFileName: "styles" },
    },
  }
  const builder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))};import solid from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))};import tailwind from ${JSON.stringify(Bun.resolveSync("@tailwindcss/vite", import.meta.dir))};await build({...${JSON.stringify(options)},plugins:[solid(),tailwind()]});process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Note reading fixture build failed")
  await Bun.write(
    path.join(directory, "dist/index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: directory,
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  page.on("pageerror", (error) => errors.push(error.message))
}, 90_000)

afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(query = "") {
  errors.length = 0
  await page.goto(server.resolvedUrls!.local[0]! + query)
  await page.locator(".tiptap").waitFor()
}

test("notes show only their authored document heading while the name remains editable in options", async () => {
  await page.setViewportSize({ width: 1100, height: 800 })
  for (const query of ["", "?plain"]) {
    await open(query)
    expect(await page.getByRole("textbox", { name: "Note title" }).isVisible()).toBe(false)
    expect(await page.locator(".tiptap h1").count()).toBe(query ? 0 : 1)
    await page.evaluate(() => {
      const root = document.querySelector(".tiptap")!
      root.setAttribute("data-retained", "yes")
      root.parentElement!.scrollTop = 360
    })
    const scroll = await page.locator(".tiptap").evaluate((el) => el.parentElement!.scrollTop)
    await page.getByRole("button", { name: "Note options" }).click()
    expect(await page.getByRole("dialog", { name: "Note options" }).isVisible()).toBe(true)
    const name = page.getByRole("textbox", { name: "Note title" })
    await name.fill("Renamed note")
    await page.waitForFunction(
      () => (window as unknown as { fixture: { writes: unknown[] } }).fixture.writes.length === 1,
    )
    expect(await page.evaluate(() => (window as unknown as { fixture: { writes: unknown[] } }).fixture.writes)).toEqual(
      [{ title: "Renamed note", expectedVersion: 1 }],
    )
    await page.keyboard.press("Escape")
    await name.waitFor({ state: "hidden" })
    expect(await name.isVisible()).toBe(false)
    expect(await page.locator(".tiptap").getAttribute("data-retained")).toBe("yes")
    expect(await page.locator(".tiptap").evaluate((el) => el.parentElement!.scrollTop)).toBeCloseTo(scroll, 0)
    expect(await page.locator(".tiptap").textContent()).toContain("保留阅读位置")
    expect(errors).toEqual([])
  }
})

test("the reading column expands in a large panel and retains the editor across resize and theme changes", async () => {
  await open()
  await page.locator(".tiptap").evaluate((el) => el.setAttribute("data-retained", "yes"))
  await page.locator(".tiptap p").first().click()
  await page.keyboard.press("End")
  await page.keyboard.insertText(" retained draft")
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [375, 900, 1728, 2560]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await page.locator(".tiptap").evaluate((el) => {
        const bounds = el.getBoundingClientRect(),
          host = el.parentElement!.getBoundingClientRect()
        const paragraph = el.querySelector("p")!,
          style = getComputedStyle(paragraph)
        return {
          width: bounds.width,
          left: bounds.left - host.left,
          right: host.right - bounds.right,
          font: parseFloat(style.fontSize),
          line: parseFloat(style.lineHeight),
          overflow: document.documentElement.scrollWidth > innerWidth,
          canvasOverflow: el.parentElement!.scrollWidth > el.parentElement!.clientWidth,
          headingTop: el.querySelector("h1")!.getBoundingClientRect().top - host.top,
        }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.canvasOverflow).toBe(false)
      expect(geometry.left).toBeGreaterThanOrEqual(15)
      expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(2)
      if (width >= 1728) {
        expect(geometry.width).toBeGreaterThanOrEqual(900)
        expect(geometry.width).toBeLessThanOrEqual(1000)
        expect(geometry.font).toBeGreaterThanOrEqual(18)
      }
      expect(geometry.line / geometry.font).toBeGreaterThanOrEqual(1.59)
      expect(geometry.headingTop).toBeLessThan(60)
      expect(await page.locator(".tiptap").getAttribute("data-retained")).toBe("yes")
    }
  }
  expect(await page.locator(".tiptap").textContent()).toContain(" retained draft")
  await page.keyboard.press("ControlOrMeta+z")
  expect(await page.locator(".tiptap").textContent()).not.toContain(" retained draft")
  expect(errors).toEqual([])
})
