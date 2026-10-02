import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import type { SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
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
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const computer = "development-computer-with-a-long-name.example:4321"
const project = "A project with a very long name that must remain accessible"

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".work-context-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    import {createStore} from "solid-js/store"
    export const [state,patch]=createStore({id:undefined,running:false,status:"idle",empty:false,disabled:false,width:700,home:false,git:true,profile:"native",error:"",extras:false,selection:{mode:"workspace",workspaceID:"main",workspaceGeneration:1}})
    const h=window.fixture={patch,requests:[],selection:undefined}
    export const directories=()=>({revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:[],folders:[{workspaceID:"main",generation:1,path:"/projects/main-folder",git:state.git,available:true}]})
    const trees=[{id:"tree",name:"Existing Worktree",branch:"feature/long-existing-worktree-branch",path:"/projects/worktrees/existing",sourceWorkspaceID:"main",bindings:[]}]
    const scope={id:"project",name:${JSON.stringify(project)},local:{worktree:"/projects/main-folder",directory:"/projects/main-folder",sandboxes:[],vcs:"git"}}
    const client={project:{async worktreeInventory(){h.requests.push("worktrees");return {data:{items:trees}}}},session:{async selectWorkspace(){h.requests.push("selectWorkspace")}}}
    export const useParams=()=>({get id(){return state.id}})
    export const useNavigate=()=>()=>{}
    export const useSDK=()=>({get isHome(){return state.home},get scopeID(){return state.home?"home":"project"},get scopeKey(){return state.home?"home":"project"},client})
    export const useGlobalSDK=()=>({url:"http://fixture.example",capabilities:{has:()=>true}})
    export const useSync=()=>({scope,data:{workspaces:[],path:{workspace:{path:"/projects/main-folder"}}},session:{get:()=>state.empty?undefined:{id:state.id,status:state.status,workspaceID:"main",workspace:{path:"/projects/main-folder",type:"git"}},sync:async()=>{}}})
    export const useLayout=()=>({scopes:{list:()=>[scope]}})
    export const useGlobalSync=()=>({refreshScopes:async()=>{}})
    export const useServer=()=>({url:"http://${computer}",list:["http://offline.example:4322"],setActive:()=>{},scopes:{open:()=>{}}})
    export const normalizeServerUrl=url=>url
    export const serverDisplayName=url=>url.replace(/^https?:\\/\\//,"")
    export const usePlatform=()=>({platform:"web",fetch:async url=>new Response(JSON.stringify({healthy:!(url instanceof Request?url.url:String(url)).includes("offline")}),{headers:{"content-type":"application/json"}})})
    export const useCommand=()=>({register:()=>{}})
    export const usePrompt=()=>({prepareProjectTransfer:()=>({commit:()=>true,release:()=>{}})})
    export const useConfirm=()=>({ask:async()=>true})
    export const DialogScopeEdit=()=>null
    export const DialogWorktrees=()=>null
    export const DialogWorkingLocation=()=>null
    export const DialogCreateProject=()=>null
    export const DialogSelectServer=()=>null
    export const DialogSelectProject=()=>null
    export const ProjectMenuContent=()=>null
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
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Dialog} from "@ericsanchezok/synergy-ui/dialog"
    import {SessionWorkContext} from ${JSON.stringify(`/@fs/${source}/components/session/work-context.tsx`)}
    import {DefaultComposer} from ${JSON.stringify(`/@fs/${source}/plugin/default-composer.tsx`)}
    import {ProjectFolderFields} from ${JSON.stringify(`/@fs/${source}/components/dialog/project-folder-fields.tsx`)}
    import {ComputerMenu} from ${JSON.stringify(`/@fs/${source}/components/dialog/computer-menu.tsx`)}
    import {state,patch,directories} from "./stubs"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function App(){
      const dialog=useDialog()
      const input={readOnly:()=>false,primaryAction:()=>"send",submit:async()=>{},stop:async()=>{},dragging:()=>false,className:()=>"",current:()=>({mode:"normal"}),setComposing:()=>{},dragOver:()=>{},dragLeave:()=>{},drop:async()=>{},
        editor:{label:()=>"Message",completion:()=>undefined,placeholder:()=>undefined,mount:()=>()=>{},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{}},
        render:part=>part==="leading"?<><div data-extension>Composer extension</div><SessionWorkContext directories={directories()} directoryError={state.error} onRefresh={()=>patch("error","")} workspaceSelection={state.selection} running={state.running} disabled={state.disabled} environmentProfile={state.profile} startOptions={[]} onSelect={selection=>{window.fixture.selection=selection;patch("selection",selection)}}>{state.extras&&<><button data-shortcuts>Quick actions</button><span data-agenda>Scheduled wake</span></>}</SessionWorkContext></>:part==="context"?<><button data-attachment>Attachment</button><p data-permission>Permission request</p><p role="alert" data-error>Request failed</p></>:part==="toolbar"?<button type="submit" data-send>Send</button>:null}
      return <><div data-pane style={{width:state.width+"px","max-width":"100%"}}><DefaultComposer context={{input}}/></div><button data-open-form onClick={()=>dialog.show(()=><Dialog title="Folder form"><div data-folder-form style={{width:"200px","max-width":"100%"}}><ProjectFolderFields folders={[]} main="" onChange={()=>{}} onAdd={()=>{}} computer={<ComputerMenu/>}/></div></Dialog>)}>Open form</button></>
    }
    render(()=> <I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "work-context-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            id === "@solidjs/router" ||
            /(?:^@\/|\/src\/)context\/(sdk|global-sdk|sync|global-sync|layout|server|platform|command|prompt)(\.tsx)?$/.test(
              id,
            ) ||
            /(?:^\.\/|^\.\.\/dialog\/|\/dialog\/)(dialog-scope-edit|dialog-worktrees|dialog-working-location|dialog-create-project|dialog-select-server|dialog-select-project|confirm-dialog)(\.tsx)?$/.test(
              id,
            )
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
      fs: { allow: [path.resolve(source, "../../.."), fixture] },
    },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function open() {
  errors.length = 0
  await page.goto(base)
  await page.locator("[data-worktree-task-selector]").waitFor()
  expect(errors).toEqual([])
}

const patch = (value: Record<string, unknown>) => page.evaluate(`window.fixture.patch(${JSON.stringify(value)})`)

test("a session identity removes setup through running, pause, completion, switching and reconnect", async () => {
  await open()
  await patch({ extras: true })
  expect(await page.locator(".session-work-context").count()).toBe(1)
  expect(await page.locator("[data-shortcuts], [data-agenda]").count()).toBe(2)
  for (const state of [
    { id: "first-task", status: "running", running: true },
    { status: "paused", running: false },
    { status: "idle" },
    { id: "second-task", status: "running", running: true },
    { empty: true },
    { empty: false, status: "idle", running: false },
  ]) {
    await patch(state)
    expect(await page.locator(".session-work-context").count()).toBe(0)
    expect(await page.locator("[data-shortcuts], [data-agenda]").count()).toBe(0)
  }
  expect(errors).toEqual([])
}, 20_000)

async function assertSingleLine() {
  const geometry = await page.locator(".session-work-context").evaluate((element) => {
    const row = element.getBoundingClientRect()
    return [...element.querySelectorAll("button")].map((button) => {
      const box = button.getBoundingClientRect()
      return { left: box.left - row.left, right: box.right - row.right, center: box.top + box.height / 2 }
    })
  })
  expect(geometry.length).toBeGreaterThanOrEqual(2)
  for (const control of geometry) {
    expect(control.left).toBeGreaterThanOrEqual(-1)
    expect(control.right).toBeLessThanOrEqual(1)
    expect(Math.abs(control.center - geometry[0]!.center)).toBeLessThanOrEqual(1)
  }
}

test("setup compacts by composer width, retaining the project until its smallest layout", async () => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await open()
  const computerLabel = page.locator("[data-computer-selector] > span")
  const projectLabel = page.locator("[data-project-task-selector] > span")
  for (const width of [700, 560, 559, 375, 320, 260, 240, 239, 200]) {
    await patch({ width })
    expect(await computerLabel.isVisible()).toBe(width >= 560)
    expect(await projectLabel.isVisible()).toBe(width >= 240)
    await assertSingleLine()
  }
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 768 })
    await patch({ width: 700 })
    expect(await computerLabel.isVisible()).toBe(false)
    expect(await projectLabel.isVisible()).toBe(true)
    await assertSingleLine()
  }
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2"
  })
  expect(await computerLabel.isVisible()).toBe(false)
  expect(await projectLabel.isVisible()).toBe(true)
  await assertSingleLine()
  await page.evaluate(() => {
    document.documentElement.style.zoom = ""
  })
  expect(errors).toEqual([])
}, 20_000)

test("compact computer controls retain full identity, actual health and keyboard focus", async () => {
  await open()
  await patch({ width: 320 })
  const trigger = page.getByRole("button", { name: `Computer: ${computer}`, exact: true })
  await trigger.focus()
  await page.getByRole("tooltip").filter({ hasText: computer }).waitFor()
  await trigger.press("Enter")
  const menu = page.getByRole("dialog", { name: "Computer", exact: true })
  const connected = menu.getByRole("button").filter({ hasText: computer })
  await connected.getByText(/Connected$/).waitFor()
  await assertSingleLine()
  expect(await connected.isDisabled()).toBe(false)
  expect(
    await menu
      .getByRole("button")
      .filter({ hasText: /offline.example:4322.*Unavailable/ })
      .isDisabled(),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-computer-selector"))
  expect(
    await page.getByRole("button", { name: `Project: ${project}`, exact: true }).getAttribute("aria-description"),
  ).toBe("/projects/main-folder")
  expect(errors).toEqual([])
}, 20_000)

test("main and Worktree icons retain the full pending or existing location without allocating on selection", async () => {
  await open()
  await patch({ width: 320 })
  const trigger = page.locator("[data-worktree-task-selector]")
  const mainIcon = await trigger.locator('[data-component="icon"]').innerHTML()
  expect(await trigger.getAttribute("aria-label")).toContain("Main folder")
  expect(await trigger.getAttribute("aria-label")).toContain("/projects/main-folder")
  await trigger.click()
  const menu = page.getByRole("dialog", { name: "Worktrees", exact: true })
  await assertSingleLine()
  await menu.getByRole("button", { name: "New Worktree Created when you start the task.", exact: true }).click()
  await menu.waitFor({ state: "detached" })
  expect(await trigger.getAttribute("aria-label")).toContain("Created when you start the task.")
  const treeIcon = await trigger.locator('[data-component="icon"]').innerHTML()
  expect(treeIcon).not.toBe(mainIcon)
  await trigger.click()
  await menu.getByRole("button", { name: "feature/long-existing-worktree-branch 0 linked tasks", exact: true }).click()
  await menu.waitFor({ state: "detached" })
  expect(await trigger.getAttribute("aria-label")).toContain("feature/long-existing-worktree-branch")
  expect(await trigger.getAttribute("aria-label")).toContain("/projects/worktrees/existing")
  expect(await trigger.locator('[data-component="icon"]').innerHTML()).toBe(treeIcon)
  expect(await page.evaluate<string[]>("window.fixture.requests")).toEqual(["worktrees"])
  expect(await page.evaluate<SessionWorkspaceSelection>("window.fixture.selection")).toEqual({
    mode: "existing",
    target: "tree",
    sourceWorkspaceID: "main",
  })
  await assertSingleLine()
  expect(errors).toEqual([])
}, 20_000)

test("a long computer name keeps the folder heading on one line and menu state preserves its geometry", async () => {
  await open()
  await page.locator("[data-open-form]").click()
  const form = page.locator("[data-folder-form]")
  await page.waitForFunction(() =>
    document.querySelector("[data-folder-form]")?.closest('[role="dialog"]')?.contains(document.activeElement),
  )
  const trigger = form.getByRole("button", { name: `Computer: ${computer}`, exact: true })
  await trigger.focus()
  await page.getByRole("tooltip").filter({ hasText: computer }).waitFor()
  await form.evaluate(async (element) => {
    const dialog = element.closest('[role="dialog"]')!
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished))
  })
  const bounds = () =>
    form.locator(".project-field-heading").evaluate((element) => {
      const row = element.getBoundingClientRect()
      const label = element.querySelector("label")!
      const button = element.querySelector("button")!.getBoundingClientRect()
      return {
        left: button.left,
        right: button.right,
        rowRight: row.right,
        labelHeight: label.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      }
    })
  const before = await bounds()
  expect(before.labelHeight).toBeLessThanOrEqual(before.lineHeight + 1)
  expect(before.right).toBeLessThanOrEqual(before.rowRight + 1)
  await trigger.press("Enter")
  const menu = page.getByRole("dialog", { name: "Computer", exact: true })
  await menu.waitFor()
  const after = await bounds()
  expect(Math.abs(after.left - before.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.right - before.right)).toBeLessThanOrEqual(1)
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.closest("[data-folder-form]") !== null)
  expect(errors).toEqual([])
}, 20_000)

test("repair and advanced location actions stay reachable in a narrow touch composer", async () => {
  const previous = page
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  try {
    await open()
    await patch({ width: 200, error: "Folders unavailable", profile: "custom" })
    await assertSingleLine()
    const trigger = page.getByRole("button", { name: "Location options", exact: true })
    await trigger.click()
    const menu = page.getByRole("dialog", { name: "Location options", exact: true })
    expect(await menu.getByRole("alert").innerText()).toBe("Folders unavailable")
    expect(await menu.getByRole("button", { name: "Developer settings", exact: true }).isVisible()).toBe(true)
    await menu.getByRole("button", { name: "Retry", exact: true }).click()
    await menu.waitFor({ state: "detached" })
    await trigger.click()
    expect(await menu.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "detached" })
    await assertSingleLine()
  } finally {
    await page.close()
    page = previous
  }
}, 20_000)

test("Home omits folder choices and a non-Git main keeps existing Worktrees without offering creation", async () => {
  await open()
  await patch({ home: true, width: 200 })
  expect(await page.locator("[data-worktree-task-selector]").count()).toBe(0)
  await assertSingleLine()
  await patch({ home: false, git: false })
  await page.locator("[data-worktree-task-selector]").click()
  const menu = page.getByRole("dialog", { name: "Worktrees", exact: true })
  expect(await menu.getByRole("button", { name: /New Worktree/ }).count()).toBe(0)
  expect(
    await menu
      .getByRole("button", { name: "feature/long-existing-worktree-branch 0 linked tasks", exact: true })
      .isEnabled(),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  expect(errors).toEqual([])
}, 20_000)

test("failed initialization retains setup and the draft; accepting a session removes only setup without a spacer", async () => {
  await open()
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep the task draft")
  const editor = await page.getByRole("textbox", { name: "Message", exact: true }).elementHandle()
  await patch({ disabled: true })
  expect(await page.locator(".session-work-context").count()).toBe(1)
  expect(await page.locator("[data-project-task-selector]").isDisabled()).toBe(true)
  await patch({ disabled: false })
  expect(await page.locator("[data-project-task-selector]").isDisabled()).toBe(false)
  expect(await page.getByRole("textbox", { name: "Message", exact: true }).innerText()).toBe("Keep the task draft")
  await patch({ id: "accepted-task", empty: true })
  expect(await page.locator(".session-work-context").count()).toBe(0)
  expect(await editor!.evaluate((element) => element.isConnected)).toBe(true)
  for (const selector of ["[data-extension]", "[data-attachment]", "[data-permission]", "[data-error]"])
    expect(await page.locator(selector).isVisible()).toBe(true)
  const gap = await page
    .locator("[data-extension]")
    .evaluate(
      (element) => element.nextElementSibling!.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
    )
  expect(Math.abs(gap)).toBeLessThanOrEqual(1)
  await patch({ id: null, empty: false })
  expect(await page.locator(".session-work-context").count()).toBe(1)
  expect(await page.getByRole("textbox", { name: "Message", exact: true }).innerText()).toBe("Keep the task draft")
  expect(errors).toEqual([])
}, 20_000)
