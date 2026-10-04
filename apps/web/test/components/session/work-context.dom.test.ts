import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import type { SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

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
    export const [state,patch]=createStore({id:undefined,running:false,status:"idle",empty:false,disabled:false,width:700,home:false,git:true,available:true,extraAvailable:true,shared:false,deriveSelection:false,mainRev:1,extraRev:1,gen:1,extraGen:1,failExtra:false,holdExtra:false,emptyTrees:false,holdInventory:false,url:"http://fixture.example",scopeID:"project",profile:"native",error:"",extras:false,selection:{mode:"workspace",workspaceID:"main",workspaceGeneration:1}})
    const h=window.fixture={patch,requests:[],selection:undefined,healthPending:0,directoryPending:0,releaseHealth:[],releaseDirectories:[],menuRequests:[]}
    const folder=id=>({workspaceID:id,generation:id==="main"?state.gen:state.extraGen,path:id==="main"?"/projects/main-folder":"/projects/shared-folder",git:id==="main"&&state.git&&state.available,available:id==="main"?state.available:state.extraAvailable,...((id==="main"?state.available:state.extraAvailable)?{}:{unavailable:{name:"WorkspaceUnavailable",data:{workspaceID:id,reason:"identity_changed",message:"Identity changed"}}})})
    export const directories=()=>({version:1,scopeID:state.scopeID,revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:state.shared?["extra"]:[],folders:[folder("main"),...(state.shared?[folder("extra")]:[])]})
    const record=id=>({id,scopeID:state.scopeID,type:"directory",revision:id==="main"?state.mainRev:state.extraRev,binding:{generation:id==="main"?state.gen:state.extraGen,state:"bound",path:folder(id).path,hostID:"host",physicalID:"identity"},lifecycle:"active",metadata:{},sharedWritableWorkspaceIDs:[],createdAt:1,updatedAt:1})
    const trees=[{id:"tree",name:"Existing Worktree",branch:"feature/long-existing-worktree-branch",path:"/projects/worktrees/existing",sourceWorkspaceID:"main",bindings:[]}]
    const scope={id:"project",type:"project",time:{updated:1},name:${JSON.stringify(project)},local:{worktree:"/projects/main-folder",directory:"/projects/main-folder",sandboxes:[],vcs:"git"}}
    const client={project:{async worktreeInventory(input,options){
      h.requests.push("worktrees");const scopeID=input.scopeID;const url=state.url
      if(state.holdInventory){h.inventoryPending=true;await new Promise(resolve=>h.releaseInventory=resolve);h.inventoryPending=false}
      options.signal?.throwIfAborted()
      return {data:{items:state.emptyTrees?[]:trees.map(tree=>({...tree,branch:scopeID==="project"&&url==="http://fixture.example"?tree.branch:"feature/new-project-worktree"}))}}
    },async directories({scopeID}){
      const url=state.url
      h.menuRequests.push({url,scopeID})
      const value=directories()
      if(url!=="http://fixture.example")value.folders[0].path="/projects/new-connection"
      if(h.holdDirectories){h.directoryPending++;await new Promise(resolve=>h.releaseDirectories.push(resolve));h.directoryPending--}
      if(h.failedDirectory===scopeID)throw Error("Directory unavailable")
      return {data:value}
    }},workspace:{async list(){return {data:[record("main"),...(state.shared?[record("extra")]:[])]}},async rebind(input,options){h.requests.push("rebind:"+input.workspaceID);if(input.workspaceID==="extra"&&state.holdExtra)await new Promise(resolve=>h.release=resolve);options.signal?.throwIfAborted();if(input.workspaceID==="extra"&&state.failExtra)throw {name:"WorkspaceBusy",data:{message:"Folder busy"}};if(input.workspaceID==="main")patch({available:true,gen:state.gen+1,mainRev:state.mainRev+1});else patch({extraAvailable:true,extraGen:state.extraGen+1,extraRev:state.extraRev+1});return {data:record(input.workspaceID)}}},session:{async selectWorkspace(){h.requests.push("selectWorkspace")}}}
    export const useParams=()=>({get id(){return state.id}})
    export const useNavigate=()=>()=>{}
    export const useSDK=()=>({get isHome(){return state.home},get scopeID(){return state.home?"home":state.scopeID},get scopeKey(){return state.home?"home":state.scopeID},client})
    export const useGlobalSDK=()=>({get url(){return state.url},capabilities:{has:()=>true},client})
    export const useSync=()=>({scope,data:{get workspaces(){return [record("main"),{id:"other",scopeID:state.scopeID,type:"git_worktree",binding:{path:"/projects/worktrees/selected",generation:2,state:"bound"},metadata:{name:"Selected copy",branch:"feature/selected"}}]},path:{workspace:{path:"/projects/main-folder"}}},session:{get:()=>state.empty?undefined:{id:state.id,status:state.status,workspaceID:"main",workspace:{path:"/projects/main-folder",type:"git"}},sync:async()=>{}}})
    export const useLayout=()=>({scopes:{list:()=>[scope]}})
    export const useGlobalSync=()=>({data:{get scope(){return [scope,...(h.failedProject?[{id:"unavailable-project",type:"project",name:"Unavailable project",time:{updated:0}}]:[])]}},refreshScopes:async()=>{}})
    export const useServer=()=>({url:"http://${computer}",list:["http://offline.example:4322"],setActive:()=>{},scopes:{open:()=>{}}})
    export const normalizeServerUrl=url=>url
    export const serverDisplayName=url=>url.replace(/^https?:\\/\\//,"")
    export const usePlatform=()=>({platform:"web",fetch:async url=>{if(h.holdHealth){h.healthPending++;await new Promise(resolve=>h.releaseHealth.push(resolve));h.healthPending--}if(h.failHealth)throw Error("Computer unavailable");return new Response(JSON.stringify({healthy:!(url instanceof Request?url.url:String(url)).includes("offline")}),{headers:{"content-type":"application/json"}})}})
    export const useCommand=()=>({register:()=>{}})
    export const usePrompt=()=>({prepareProjectTransfer:()=>({commit:()=>true,release:()=>{}})})
    export const useConfirm=()=>({ask:async()=>true})
    export const useProjectDirectoryPicker=()=>({pickProjectDirectories:async()=>null})
    export const SessionDecisionOutlet=()=>null
    export const DialogScopeEdit=()=>null
    export const DialogWorktrees=()=>null
    export const DialogWorkingLocation=()=>null
    export const DialogCreateProject=()=>null
    export const DialogSelectServer=()=>null
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {createSignal} from "solid-js"
    import {render} from "solid-js/web"
    import {LocaleProvider} from "${source}/context/locale"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {WelcomeStage} from "${source}/components/session/welcome/stage"
    import {welcomeScenes} from "${source}/components/session/welcome/registry"
    import {createWelcomeMemory} from "${source}/components/session/welcome/types"
    import {DefaultSession} from "${source}/plugin/default-session"
    import {PromptDock} from "${source}/components/session/prompt-dock"
    import {createPromptDockHeight} from "${source}/components/session/prompt-dock-height"
    import "@ericsanchezok/synergy-ui/styles"
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
      const memory=createWelcomeMemory()
      const [height,setHeight]=createSignal(0)
      const dock=createPromptDockHeight(setHeight)
      const input={readOnly:()=>false,primaryAction:()=>"send",submit:async()=>{},stop:async()=>{},dragging:()=>false,className:()=>"",current:()=>({mode:"normal"}),setComposing:()=>{},dragOver:()=>{},dragLeave:()=>{},drop:async()=>{},
        editor:{label:()=>"Message",completion:()=>undefined,placeholder:()=>undefined,mount:()=>()=>{},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{}},
        render:part=>part==="leading"?<><div data-extension>Composer extension</div><SessionWorkContext directories={directories()} directoryError={state.error} onRefresh={()=>patch("error","")} workspaceSelection={state.deriveSelection&&state.selection.mode==="workspace"?{...state.selection,workspaceGeneration:state.gen}:state.selection} workspaceSelectionKey={JSON.stringify(state.selection)} running={state.running} disabled={state.disabled} environmentProfile={state.profile} startOptions={[]} onSelect={selection=>{window.fixture.selection=selection;patch("selection",selection)}}>{state.extras&&<><button data-shortcuts>Quick actions</button><span data-agenda>Scheduled wake</span></>}</SessionWorkContext></>:part==="context"?<><button data-attachment>Attachment</button><p data-permission>Permission request</p><p role="alert" data-error>Request failed</p></>:part==="toolbar"?<button type="submit" data-send>Send</button>:null}
      if(new URLSearchParams(location.search).has("welcome")) {
        const composer={input:()=>input,mount:dock.mount,ready:()=>true,readOnly:()=>false,links:()=>[],render:()=>null}
        return <div data-pane style={{width:state.width+"px",height:"100dvh","max-width":"100%"}}><DefaultSession context={{layout:{
          minimumWidth:()=>undefined,promptHeight:height,
          render:part=>part==="composer"?<PromptDock context={composer}/>:part==="conversation"?<div class="flex-1 min-h-0"><div class="session-empty-view" data-interactive><div class="session-welcome-region"><WelcomeStage definition={welcomeScenes.find(scene=>scene.id==="flight")} seed={8} memory={memory} blocked={!!dialog.active}/></div></div></div>:null
        }}}/></div>
      }
      return <><div data-pane style={{width:state.width+"px","max-width":"100%"}}><DefaultComposer context={{input}}/></div><button data-open-form onClick={()=>dialog.show(()=><Dialog title="Folder form"><div data-folder-form style={{width:"200px","max-width":"100%"}}><ProjectFolderFields folders={[]} main="" onChange={()=>{}} onAdd={()=>{}} computer={<ComputerMenu/>}/></div></Dialog>)}>Open form</button></>
    }
    render(()=> <LocaleProvider><ThemeProvider><DialogProvider><App/></DialogProvider></ThemeProvider></LocaleProvider>,document.getElementById("root"))
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
            id.endsWith("/session/decision-surface") ||
            /(?:^@\/|\/src\/)context\/(sdk|global-sdk|sync|global-sync|layout|server|platform|command|prompt)(\.tsx)?$/.test(
              id,
            ) ||
            /(?:^\.\/|^\.\.\/dialog\/|\/dialog\/)(dialog-scope-edit|dialog-worktrees|dialog-working-location|dialog-create-project|dialog-select-server|confirm-dialog|project-directory-picker)(\.tsx)?$/.test(
              id,
            )
          )
            return stubs
        },
      },
      solid(),
      tailwind(),
      ...lingui(),
    ],
    resolve: { alias: { "@": source } },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "zod", "fuzzysort"],
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
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  context.setDefaultTimeout(4000)
  page = await context.newPage()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function open(welcome = false) {
  errors.length = 0
  const previous = page
  page = await previous.context().newPage()
  await page.setViewportSize(previous.viewportSize()!)
  await previous.close()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(welcome ? `${base}?welcome` : base)
  await page.locator("[data-worktree-task-selector]").waitFor()
  expect(errors).toEqual([])
}

const patch = (value: Record<string, unknown>) => page.evaluate(`window.fixture.patch(${JSON.stringify(value)})`)

test("explicit directory selections show their actual location and clear it for no project files", async () => {
  await open()
  await patch({ selection: { mode: "workspace", workspaceID: "other", workspaceGeneration: 2 } })
  const trigger = page.locator("[data-worktree-task-selector]")
  expect(await trigger.getAttribute("aria-label")).toContain("feature/selected")
  expect(await trigger.getAttribute("aria-label")).toContain("/projects/worktrees/selected")
  await patch({ git: false })
  expect(await trigger.isVisible()).toBe(true)
  await patch({ selection: { mode: "none" } })
  expect(await trigger.getAttribute("aria-label")).toBe("No project files")
  await patch({ selection: { mode: "workspace", workspaceID: "missing", workspaceGeneration: 1 } })
  expect(await trigger.getAttribute("aria-label")).not.toContain("/projects/main-folder")
}, 20_000)

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
  await page.waitForTimeout(900)
  expect(await page.getByRole("tooltip").count()).toBe(0)
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
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  page = await context.newPage()
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
    await context.close()
    page = previous
  }
}, 20_000)

test("Home omits folder choices and a non-Git main explains disabled Worktree creation", async () => {
  await open()
  await patch({ home: true, width: 200 })
  expect(await page.locator("[data-worktree-task-selector]").count()).toBe(0)
  await assertSingleLine()
  await patch({ home: false, git: false })
  await page.locator("[data-worktree-task-selector]").click()
  const menu = page.getByRole("dialog", { name: "Worktrees", exact: true })
  expect(await menu.getByRole("button", { name: /New Worktree/ }).isDisabled()).toBe(true)
  expect(await menu.getByText("The main folder is not a Git repository.").isVisible()).toBe(true)
  expect(
    await menu
      .getByRole("button", { name: "feature/long-existing-worktree-branch 0 linked tasks", exact: true })
      .isEnabled(),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  expect(errors).toEqual([])
}, 20_000)

test("refreshed Worktrees never retain the prior project or connection while loading", async () => {
  for (const changed of [{ scopeID: "next-project" }, { url: "http://next-computer.example" }]) {
    await open()
    const trigger = page.locator("[data-worktree-task-selector]")
    await trigger.click()
    const menu = page.getByRole("dialog", { name: "Worktrees", exact: true })
    const prior = menu.getByRole("button", { name: /feature\/long-existing-worktree-branch/ })
    await prior.waitFor()
    await patch({ ...changed, holdInventory: true })
    expect(await prior.count()).toBe(0)
    await page.waitForFunction("window.fixture.inventoryPending")
    await page.evaluate("window.fixture.releaseInventory()")
    await menu.getByRole("button", { name: /feature\/new-project-worktree/ }).waitFor()
    expect(await prior.count()).toBe(0)
  }
  expect(errors).toEqual([])
}, 20_000)

test("all three setup controls suppress hover and focus tooltips", async () => {
  await open()
  for (const selector of [
    "[data-computer-selector]",
    "[data-project-task-selector]",
    "[data-worktree-task-selector]",
  ]) {
    const trigger = page.locator(selector)
    await trigger.hover()
    await page.waitForTimeout(900)
    expect(await page.getByRole("tooltip").count()).toBe(0)
    await trigger.focus()
    await page.waitForTimeout(900)
    expect(await page.getByRole("tooltip").count()).toBe(0)
  }
}, 20_000)

async function openRecovery() {
  await page.locator("[data-worktree-task-selector]").click()
  await page
    .getByRole("dialog", { name: "Worktrees", exact: true })
    .getByRole("button", { name: /New Worktree/ })
    .click()
  const dialog = page.getByRole("dialog", { name: "Confirm project folders", exact: true })
  await dialog.getByRole("button", { name: "Confirm and restore", exact: true }).waitFor()
  return dialog
}

test("an unavailable main without Worktrees offers confirmation and cancellation keeps the editor and draft", async () => {
  await open()
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft")
  const editor = await page.getByRole("textbox", { name: "Message", exact: true }).elementHandle()
  await patch({ available: false, git: false, emptyTrees: true, gen: 2 })
  const dialog = await openRecovery()
  expect(await dialog.getByText("/projects/main-folder", { exact: true }).isVisible()).toBe(true)
  expect(await dialog.getByRole("button", { name: "Choose folder", exact: true }).count()).toBe(0)
  expect(
    (await page.evaluate<string[]>("window.fixture.requests")).filter((value) => value.startsWith("rebind:")),
  ).toEqual([])
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await dialog.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-worktree-task-selector"))
  expect(await editor!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await page.getByRole("textbox", { name: "Message", exact: true }).innerText()).toBe("Keep this draft")
  expect(await page.evaluate("window.fixture.selection")).toBeUndefined()
  expect(errors).toEqual([])
}, 20_000)

test("recovery keeps partial success, blocks duplicate confirmation and selects deferred creation after retry", async () => {
  await open()
  const editor = await page.getByRole("textbox", { name: "Message", exact: true }).elementHandle()
  await patch({
    available: false,
    extraAvailable: false,
    shared: true,
    deriveSelection: true,
    failExtra: true,
    holdExtra: true,
  })
  const dialog = await openRecovery()
  await dialog
    .getByRole("button", { name: "Confirm and restore", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await page.waitForFunction("window.fixture.requests.includes('rebind:extra')")
  expect(
    (await page.evaluate<string[]>("window.fixture.requests")).filter((value) => value.startsWith("rebind:")),
  ).toEqual(["rebind:main", "rebind:extra"])
  await page.evaluate("window.fixture.release()")
  await dialog.getByRole("alert").waitFor()
  expect(await dialog.getByText("Ready", { exact: true }).isVisible()).toBe(true)
  expect(await page.evaluate("window.fixture.selection")).toBeUndefined()
  await patch({ failExtra: false, holdExtra: false })
  await dialog.getByRole("button", { name: "Confirm and restore", exact: true }).click()
  await dialog.waitFor({ state: "detached" })
  expect(await page.evaluate<SessionWorkspaceSelection>("window.fixture.selection")).toEqual({
    mode: "create",
    sourceWorkspaceID: "main",
  })
  expect(
    (await page.evaluate<string[]>("window.fixture.requests")).filter((value) => value.startsWith("rebind:")),
  ).toEqual(["rebind:main", "rebind:extra", "rebind:extra"])
  expect(await editor!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await page.locator("[data-worktree-task-selector]").getAttribute("aria-label")).toContain(
    "Created when you start the task.",
  )
  expect(errors).toEqual([])
}, 20_000)

test("switching projects during recovery cancels the old operation and leaves the new intent alone", async () => {
  await open()
  await patch({ available: false, extraAvailable: false, shared: true, holdExtra: true })
  const dialog = await openRecovery()
  await dialog.getByRole("button", { name: "Confirm and restore", exact: true }).click()
  await page.waitForFunction("window.fixture.requests.includes('rebind:extra')")
  await patch({ scopeID: "other-project" })
  await dialog.waitFor({ state: "detached" })
  await page.evaluate("window.fixture.release()")
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  expect(await page.evaluate("window.fixture.selection")).toBeUndefined()
  expect(await page.evaluate<string[]>("window.fixture.requests.filter(value=>value.startsWith('rebind:'))")).toEqual([
    "rebind:main",
    "rebind:extra",
  ])
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

test("computer and project metadata keep the composer and welcome canvas stable while loading", async () => {
  await page.setViewportSize({ width: 1024, height: 920 })
  for (const kind of ["computer", "project"] as const) {
    await open(true)
    const editor = page.getByRole("textbox", { name: "Message", exact: true })
    await editor.fill("Keep the draft while menus load")
    await page.locator(".welcome-game-canvas").press("Space")
    await page.locator(".welcome-game-canvas").press("Escape")
    await page.locator(".welcome-stage").evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: Record<string, unknown> }).fixture
      fixture.holdHealth = true
      fixture.holdDirectories = true
      fixture.nodes = [
        ".session-work-context",
        ".session-composer",
        ".welcome-game-canvas",
        "[data-component=prompt-input]",
      ].map((selector) => document.querySelector(selector))
    })
    const measure = () =>
      page.evaluate(() => {
        const fixture = (window as unknown as { fixture: { nodes: Element[] } }).fixture
        return fixture.nodes.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return { x, y, width, height, connected: element.isConnected }
        })
      })
    const before = await measure()
    const position = await page.locator(".welcome-game-canvas").getAttribute("aria-description")
    const unchanged = async () => {
      const after = await measure()
      for (const [index, bounds] of after.entries()) {
        expect(bounds.connected).toBe(true)
        for (const dimension of ["x", "y", "width", "height"] as const)
          expect(Math.abs(bounds[dimension] - before[index]![dimension])).toBeLessThanOrEqual(1)
      }
      expect(await editor.innerText()).toBe("Keep the draft while menus load")
      expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("playing")
      expect(await page.locator(".welcome-game-canvas").getAttribute("aria-description")).toBe(position)
    }
    await page.locator(kind === "computer" ? "[data-computer-selector]" : "[data-project-task-selector]").click()
    await page.waitForFunction(
      (kind) =>
        (window as unknown as { fixture: Record<string, number> }).fixture[
          kind === "computer" ? "healthPending" : "directoryPending"
        ] > 0,
      kind,
    )
    expect(await page.locator(".session-work-context").isVisible()).toBe(true)
    await unchanged()
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          fixture: {
            holdHealth: boolean
            holdDirectories: boolean
            releaseHealth: (() => void)[]
            releaseDirectories: (() => void)[]
          }
        }
      ).fixture
      fixture.holdHealth = fixture.holdDirectories = false
      for (const release of [...fixture.releaseHealth, ...fixture.releaseDirectories]) release()
    })
    await page.waitForFunction(() => {
      const fixture = (window as unknown as { fixture: { healthPending: number; directoryPending: number } }).fixture
      return !fixture.healthPending && !fixture.directoryPending
    })
    await unchanged()
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      (kind) =>
        document.activeElement?.hasAttribute(
          kind === "computer" ? "data-computer-selector" : "data-project-task-selector",
        ),
      kind,
    )
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: Record<string, unknown> }).fixture
      fixture.holdHealth = true
      fixture.holdDirectories = true
      fixture.failHealth = true
      fixture.failedDirectory = "project"
    })
    await page.locator(kind === "computer" ? "[data-computer-selector]" : "[data-project-task-selector]").click()
    await page.waitForFunction(
      (kind) =>
        (window as unknown as { fixture: Record<string, number> }).fixture[
          kind === "computer" ? "healthPending" : "directoryPending"
        ] > 0,
      kind,
    )
    await unchanged()
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      (kind) =>
        document.activeElement?.hasAttribute(
          kind === "computer" ? "data-computer-selector" : "data-project-task-selector",
        ),
      kind,
    )
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { fixture: { releaseHealth: (() => void)[]; releaseDirectories: (() => void)[] } }
      ).fixture
      for (const release of [...fixture.releaseHealth, ...fixture.releaseDirectories]) release()
    })
    await page.waitForFunction(() => {
      const fixture = (window as unknown as { fixture: { healthPending: number; directoryPending: number } }).fixture
      return !fixture.healthPending && !fixture.directoryPending
    })
    await unchanged()
    expect(errors).toEqual([])
  }
}, 30_000)

test("project directory failures stay local and a late connection response cannot replace current paths", async () => {
  await open()
  await page.evaluate(() => {
    const fixture = (window as unknown as { fixture: Record<string, unknown> }).fixture
    fixture.failedProject = true
    fixture.failedDirectory = "unavailable-project"
  })
  await page.locator("[data-project-task-selector]").click()
  const menu = page.getByRole("dialog", { name: "Choose project", exact: true })
  await menu.getByText("Directory unavailable", { exact: true }).waitFor()
  expect(await menu.getByRole("button").filter({ hasText: "Unavailable project" }).isEnabled()).toBe(true)
  expect(await menu.getByText("projects/main-folder", { exact: true }).isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-project-task-selector"))
  await page.evaluate(() => {
    const fixture = (window as unknown as { fixture: Record<string, unknown> }).fixture
    fixture.holdDirectories = true
  })
  await page.locator("[data-project-task-selector]").click()
  await page.waitForFunction(
    () => (window as unknown as { fixture: { directoryPending: number } }).fixture.directoryPending > 0,
  )
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { fixture: { holdDirectories: boolean; patch(value: { url: string }): void } }
    ).fixture
    fixture.holdDirectories = false
    fixture.patch({ url: "http://next-fixture.example" })
  })
  await menu.getByText("projects/new-connection", { exact: true }).waitFor()
  await page.evaluate(() => {
    for (const release of (window as unknown as { fixture: { releaseDirectories: (() => void)[] } }).fixture
      .releaseDirectories)
      release()
  })
  await page.waitForFunction(
    () => !(window as unknown as { fixture: { directoryPending: number } }).fixture.directoryPending,
  )
  expect(await menu.getByText("projects/new-connection", { exact: true }).isVisible()).toBe(true)
  expect(await menu.getByText("projects/main-folder", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
}, 30_000)
