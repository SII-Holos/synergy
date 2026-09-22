import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".workspace-dialog-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    const record = (id, p, state="bound") => ({id,scopeID:"scope",type:"directory",revision:1,binding:{hostID:"host",path:p,generation:1,state},metadata:{},sharedWritableWorkspaceIDs:[],lifecycle:"active",createdAt:1,updatedAt:1})
    const rows=[record("wsp_a","/first"),record("wsp_b","/second"),record("wsp_history","/foreign","unbound")]
    const listeners = new Set()
    const requests=[]
    const h=window.fixture={ requests, rows, selected:[], fail:false, pick:"/new", emit(record){listeners.forEach(fn=>fn({properties:record}))} }
    export const useSDK=()=>({scopeID:"scope",client:{workspace:{
      async list(){return {data:structuredClone(rows)}},
      async register(input){requests.push({kind:"register",...input});const next=record("wsp_new",input.path);rows.push(next);return {data:next}},
      async setSharing(input){requests.push({kind:"share",...input});if(h.fail)throw new Error("Workspace changed before sharing");const row=rows.find(row=>row.id===input.workspaceID);row.revision++;row.sharedWritableWorkspaceIDs=input.workspaceIDs;return {data:structuredClone(row)}},
      async rebind(input){requests.push({kind:"rebind",...input});const row=rows.find(row=>row.id===input.workspaceID);row.revision++;row.binding={...row.binding,state:"bound",path:input.path,generation:row.binding.generation+1};return {data:structuredClone(row)}}},
      session:{async selectWorkspace(input){requests.push({kind:"select",...input});if(h.fail)throw new Error("Session is busy");return {data:{}}}}},
      event:{on(type,fn){listeners.add(fn);return()=>listeners.delete(fn)}}})
    export const useSync=()=>({data:{path:{workspace:{id:"wsp_a"}}},session:{get:()=>({workspaceID:"wsp_a"})}})
    export const useProjectDirectoryPicker=()=>({async pickProjectDirectories(){return {directoryPaths:[h.pick],source:"server-browser"}}})
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
    import {DialogWorkspace} from ${JSON.stringify(`/@fs/${appSrc}/components/dialog/dialog-workspace.tsx`)}
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=><DialogWorkspace sessionID="session" onSelect={value=>window.fixture.selected.push(value)}/>)}>Open</button>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "workspace-dialog-fixture",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            importer?.endsWith("/dialog-workspace.tsx") &&
            (["@/context/sdk", "@/context/sync", "./project-directory-picker"].includes(source) ||
              /\/context\/(sdk|sync)(\.tsx)?$/.test(source))
          )
            return stubs
        },
      },
      solid(),
    ],
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

test("selecting a Workspace preserves Scope and reports busy failures without dismissing", async () => {
  await open()
  await page.getByRole("button", { name: "/second", exact: true }).click()
  await page.evaluate("window.fixture.fail=true")
  await page.getByRole("button", { name: "Use Workspace", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.getByRole("alert").textContent()).toContain("Session is busy")
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Use Workspace", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    scopeID: "scope",
    sessionID: "session",
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_b", workspaceGeneration: 1 },
  })
  expect(errors).toEqual([])
}, 20_000)

test("sharing keeps its original revision after an external update and new directories can be selected", async () => {
  await open()
  await page.locator('[data-slot="checkbox-checkbox-label"]').filter({ hasText: "/second" }).click()
  await page.evaluate("window.fixture.emit({...window.fixture.rows[0],revision:2})")
  await page.evaluate("window.fixture.fail=true")
  await page.getByRole("button", { name: "Save sharing", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "share",
    expectedRevision: 1,
    workspaceIDs: ["wsp_b"],
  })
  expect(await page.getByRole("checkbox", { name: "/second", exact: true }).isChecked()).toBe(true)
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Add directory", exact: true }).click()
  await page.getByRole("button", { name: "/new", exact: true }).waitFor()
  await page.getByRole("button", { name: "Use Workspace", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.selected.at(-1)")).toMatchObject({
    mode: "workspace",
    workspaceID: "wsp_new",
    workspaceGeneration: 1,
  })
  expect(errors).toEqual([])
}, 20_000)

test("unbound history needs an explicit rebind and Escape returns focus", async () => {
  await open()
  await page.getByRole("button", { name: /\/foreign/ }).click()
  expect(await page.getByRole("button", { name: "Use Workspace", exact: true }).isDisabled()).toBe(true)
  await page.locator("summary").click()
  await page.getByLabel("New local directory", { exact: true }).fill("/rebound")
  await page.evaluate("window.fixture.emit({...window.fixture.rows[2],revision:2})")
  await page.getByRole("button", { name: "Rebind Workspace", exact: true }).click()
  await page.getByRole("button", { name: "/rebound", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Use Workspace", exact: true }).isEnabled()).toBe(true)
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "rebind",
    scopeID: "scope",
    workspaceID: "wsp_history",
    expectedRevision: 1,
    path: "/rebound",
  })
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.id === "open")
  expect(errors).toEqual([])
}, 20_000)
