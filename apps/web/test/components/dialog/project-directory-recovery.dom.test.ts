import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import type { ProjectDirectories } from "@ericsanchezok/synergy-sdk/client"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

type RecoveryFixture = {
  writes: { scopeID: string; workspaceID: string; expectedRevision: number; path: string }[]
  recovered: ProjectDirectories[]
  picks: { title: string; multiple: boolean }[]
  failExtra: boolean
  directories: ProjectDirectories
  patch(owner: Record<string, unknown>): void
  finishPick(path: string | null): void
  rejectPick(): void
}

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const facts = () => page.evaluate(() => (window as unknown as { fixture: RecoveryFixture }).fixture)

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".project-directory-recovery-"))
  const stubs = path.join(fixture, "stubs.ts")
  await Bun.write(
    stubs,
    `
    import {createStore} from "solid-js/store"
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    export const [owner,patch]=createStore({scopeID:"project",url:"http://fixture.test",current:true,revision:1})
    const query=new URLSearchParams(location.search)
    const ids=query.has("shared")?["main","extra"]:["main"]
    const folders=ids.map(workspaceID=>({workspaceID,generation:1,path:"/fixture/"+workspaceID,available:false,git:false,
      unavailable:{name:"WorkspaceUnavailable",data:{workspaceID,reason:workspaceID==="extra"?"directory_unavailable":query.get("reason")??"identity_changed",message:"Directory identity cannot be verified"}}}))
    const records=folders.map(folder=>({id:folder.workspaceID,scopeID:"project",type:"directory",revision:1,
      binding:{state:"bound",hostID:"host",path:folder.path,physicalID:"old",generation:1},metadata:{},sharedWritableWorkspaceIDs:[],lifecycle:"active",createdAt:1,updatedAt:1}))
    const h=window.fixture={patch,writes:[],recovered:[],picks:[],failExtra:false,
      directories:{version:1,scopeID:"project",revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:ids.slice(1),folders}}
    export const snapshot=()=>({...structuredClone(h.directories),revision:owner.revision})
    const client=createSynergyClient({baseUrl:"http://fixture.test",fetch:async request=>{
      request.signal.throwIfAborted()
      const url=new URL(request.url)
      if(request.method==="GET")return Response.json(url.pathname==="/workspace"?records:h.directories)
      const workspaceID=url.pathname.split("/")[2]
      const input=await request.json()
      h.writes.push({scopeID:url.searchParams.get("scopeID"),workspaceID,...input})
      if(workspaceID==="extra"&&h.failExtra)return Response.json({name:"WorkspaceBusy",data:{message:"Folder is in use"}},{status:409})
      const record=records.find(record=>record.id===workspaceID)
      if(record.revision!==input.expectedRevision)return Response.json({name:"WorkspaceBindingChanged",data:{message:"Binding changed"}},{status:409})
      record.revision++;record.binding.generation++;record.binding.path=input.path
      const folder=h.directories.folders.find(folder=>folder.workspaceID===workspaceID)
      Object.assign(folder,{available:true,path:input.path,generation:record.binding.generation});delete folder.unavailable
      return Response.json(record)
    }})
    export const useSDK=()=>({client,get scopeID(){return owner.scopeID}})
    export const useGlobalSDK=()=>({client,get url(){return owner.url}})
    export const useProjectDirectoryPicker=()=>({pickProjectDirectories(options){
      h.picks.push(options)
      return new Promise((resolve,reject)=>{
        h.finishPick=path=>resolve(path===null?null:{directoryPaths:[path],source:"server-browser"})
        h.rejectPick=()=>reject(new Error("Directory picker failed"))
      })
    }})
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DialogProjectDirectoryRecovery} from ${JSON.stringify(`/@fs/${source}/components/dialog/dialog-project-directory-recovery.tsx`)}
    import {owner,snapshot} from "./stubs"
    import "@ericsanchezok/synergy-ui/styles"
    function App(){const dialog=useDialog();return <button onClick={()=>dialog.show(()=><DialogProjectDirectoryRecovery directories={snapshot()} isCurrent={()=>owner.current} onRecovered={directories=>{window.fixture.recovered.push(directories)}}/>)}>Open recovery</button>}
    render(()=><ThemeProvider><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider></ThemeProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "project-directory-recovery-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            ["@/context/sdk", "@/context/global-sdk", "./project-directory-picker"].includes(id) ||
            /\/context\/(sdk|global-sdk)(\.tsx)?$/.test(id)
          )
            return stubs
        },
      },
      solid(),
      tailwind(),
    ],
    resolve: { alias: { "@": source } },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "zod"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      watch: null,
      fs: { allow: [path.resolve(source, "../../.."), fixture] },
    },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  const warmup = await browser.newPage()
  warmup.on("pageerror", (error) => errors.push(error.message))
  warmup.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  try {
    await warmup.goto(base, { timeout: 60_000 })
    await warmup.getByRole("button", { name: "Open recovery", exact: true }).waitFor()
  } catch (error) {
    throw new Error(`${String(error)}\n${errors.join("\n")}`)
  } finally {
    await warmup.close()
  }
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(15_000)
  page.on("pageerror", (error) => errors.push(error.message))
})

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function open(query = "") {
  await page.goto(base + query)
  await page.getByRole("button", { name: "Open recovery", exact: true }).click()
  const recovery = page.getByRole("dialog")
  await recovery.locator('[aria-busy="false"]').waitFor()
  return recovery
}

const continueButton = () => page.getByRole("button", { name: /^Continue using (this folder|these folders)$/ })
const chooseButton = () => page.getByRole("button", { name: "Choose another folder", exact: true })

test("identity changes explain the failure beside the original path and keep both recovery actions available", async () => {
  const recovery = await open()
  expect(await recovery.getByText(/folder at this location has changed/i).isVisible()).toBe(true)
  expect(await recovery.getByText("/fixture/main", { exact: true }).isVisible()).toBe(true)
  expect(await chooseButton().count()).toBe(1)
  expect(await continueButton().innerText()).toBe("Continue using this folder")
  expect(await continueButton().isEnabled()).toBe(true)
  expect(await recovery.getByRole("textbox").count()).toBe(0)
  expect((await facts()).writes).toEqual([])
  await recovery.getByRole("button", { name: "Cancel", exact: true }).click()
  await recovery.waitFor({ state: "detached" })
  expect((await facts()).recovered).toEqual([])
  expect((await facts()).writes).toEqual([])
  expect(errors).toEqual([])
})

test("multiple failures retain their original paths and only submit picker choices after explicit confirmation", async () => {
  const recovery = await open("?shared")
  expect(await chooseButton().count()).toBe(2)
  expect(await continueButton().innerText()).toBe("Continue using these folders")
  expect(await recovery.getByText(/cannot be opened/i).isVisible()).toBe(true)
  await chooseButton().first().click()
  expect(await continueButton().isDisabled()).toBe(true)
  await page.evaluate(() =>
    (window as unknown as { fixture: RecoveryFixture }).fixture.finishPick("/fixture/replacement"),
  )
  await recovery.getByText("/fixture/replacement", { exact: true }).waitFor()
  expect(await recovery.getByText("/fixture/main", { exact: true }).isVisible()).toBe(true)
  expect(await recovery.getByText("/fixture/extra", { exact: true }).isVisible()).toBe(true)
  expect((await facts()).writes).toEqual([])
  expect((await facts()).recovered).toEqual([])
  await chooseButton().first().click()
  await page.evaluate(() => (window as unknown as { fixture: RecoveryFixture }).fixture.finishPick(null))
  expect(await recovery.getByText("/fixture/replacement", { exact: true }).isVisible()).toBe(true)
  expect((await facts()).picks).toEqual([
    { title: "Choose another folder", multiple: false },
    { title: "Choose another folder", multiple: false },
  ])
  await continueButton().click()
  await recovery.waitFor({ state: "detached" })
  expect((await facts()).writes).toEqual([
    { scopeID: "project", workspaceID: "main", expectedRevision: 1, path: "/fixture/replacement" },
    { scopeID: "project", workspaceID: "extra", expectedRevision: 1, path: "/fixture/extra" },
  ])
  expect((await facts()).recovered[0]?.folders.map((folder) => folder.path)).toEqual([
    "/fixture/replacement",
    "/fixture/extra",
  ])
  expect(errors).toEqual([])
})

test("picker rejection stays in the recovery dialog and cancellation leaves the original plan intact", async () => {
  const recovery = await open("?reason=directory_unavailable")
  await recovery.getByRole("button", { name: /^Choose (another )?folder$/ }).click()
  await page.evaluate(() => (window as unknown as { fixture: RecoveryFixture }).fixture.rejectPick())
  await recovery.getByRole("alert").waitFor()
  expect(await recovery.getByRole("alert").innerText()).toContain("Directory picker failed")
  expect(await recovery.getByText("/fixture/main", { exact: true }).isVisible()).toBe(true)
  expect((await facts()).writes).toEqual([])
  await chooseButton().click()
  await page.evaluate(() => (window as unknown as { fixture: RecoveryFixture }).fixture.finishPick(null))
  expect(await recovery.getByText("/fixture/main", { exact: true }).isVisible()).toBe(true)
  expect((await facts()).writes).toEqual([])
  await chooseButton().click()
  await page.evaluate(() =>
    (window as unknown as { fixture: RecoveryFixture }).fixture.finishPick("/fixture/replacement"),
  )
  await recovery.getByText("/fixture/replacement", { exact: true }).waitFor()
  expect(await recovery.getByRole("alert").count()).toBe(0)
  expect((await facts()).writes).toEqual([])
  await continueButton().click()
  await recovery.waitFor({ state: "detached" })
  expect((await facts()).writes).toEqual([
    { scopeID: "project", workspaceID: "main", expectedRevision: 1, path: "/fixture/replacement" },
  ])
  expect(errors).toEqual([])
})

test("partial recovery retains success and retries only the busy folder without forcing a rebind", async () => {
  const recovery = await open("?shared")
  await page.evaluate(() => {
    ;(window as unknown as { fixture: RecoveryFixture }).fixture.failExtra = true
  })
  await continueButton().click()
  await recovery.getByRole("alert").waitFor()
  expect(await recovery.getByRole("alert").innerText()).toContain("Folder is in use")
  expect(await recovery.getByText("Ready", { exact: true }).isVisible()).toBe(true)
  expect(await chooseButton().count()).toBe(1)
  expect(await continueButton().innerText()).toBe("Continue using this folder")
  expect((await facts()).recovered).toEqual([])
  await page.evaluate(() => {
    ;(window as unknown as { fixture: RecoveryFixture }).fixture.failExtra = false
  })
  await continueButton().click()
  await recovery.waitFor({ state: "detached" })
  expect((await facts()).writes).toEqual([
    { scopeID: "project", workspaceID: "main", expectedRevision: 1, path: "/fixture/main" },
    { scopeID: "project", workspaceID: "extra", expectedRevision: 1, path: "/fixture/extra" },
    { scopeID: "project", workspaceID: "extra", expectedRevision: 1, path: "/fixture/extra" },
  ])
  expect((await facts()).recovered).toHaveLength(1)
  expect(errors).toEqual([])
})

test("a late picker result cannot recover after the project, connection, revision or caller intent changes", async () => {
  for (const owner of [
    { scopeID: "other-project" },
    { url: "http://other-fixture.test" },
    { revision: 2 },
    { current: false },
  ]) {
    const recovery = await open("?reason=directory_unavailable")
    await recovery.getByRole("button", { name: /^Choose (another )?folder$/ }).click()
    await page.evaluate((owner) => (window as unknown as { fixture: RecoveryFixture }).fixture.patch(owner), owner)
    await recovery.waitFor({ state: "detached" })
    await page.evaluate(() => (window as unknown as { fixture: RecoveryFixture }).fixture.finishPick("/fixture/late"))
    expect((await facts()).writes).toEqual([])
    expect((await facts()).recovered).toEqual([])
  }
  expect(errors).toEqual([])
}, 20_000)
