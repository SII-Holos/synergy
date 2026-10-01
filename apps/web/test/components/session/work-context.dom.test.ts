import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
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
    export const [state,patch]=createStore({id:undefined,running:false,status:"idle",empty:false,disabled:false,width:700,home:false,git:true,profile:"native",selection:{mode:"workspace",workspaceID:"main",workspaceGeneration:1}})
    const h=window.fixture={patch,requests:[],selection:undefined}
    export const directories=()=>({revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:[],folders:[{workspaceID:"main",generation:1,path:"/projects/main-folder",git:state.git,available:true}]})
    const trees=[{id:"tree",name:"Existing Worktree",branch:"feature/long-existing-worktree-branch",path:"/projects/worktrees/existing",sourceWorkspaceID:"main",bindings:[]}]
    const scope={id:"project",name:${JSON.stringify(project)},local:{worktree:"/projects/main-folder",directory:"/projects/main-folder",sandboxes:[],vcs:"git"}}
    const client={project:{async worktrees(){h.requests.push("worktrees");return {data:trees}}},session:{async selectWorkspace(){h.requests.push("selectWorkspace")}}}
    export const useParams=()=>({get id(){return state.id}})
    export const useNavigate=()=>()=>{}
    export const useSDK=()=>({get isHome(){return state.home},get scopeID(){return state.home?"home":"project"},get scopeKey(){return state.home?"home":"project"},client})
    export const useGlobalSDK=()=>({capabilities:{has:()=>true}})
    export const useSync=()=>({scope,data:{path:{workspace:{path:"/projects/main-folder"}}},session:{get:()=>state.empty?undefined:{id:state.id,status:state.status,workspaceID:"main",workspace:{path:"/projects/main-folder",type:"git"}},sync:async()=>{}}})
    export const useLayout=()=>({scopes:{list:()=>[scope]}})
    export const useGlobalSync=()=>({refreshScopes:async()=>{}})
    export const useServer=()=>({url:"http://${computer}",list:["http://offline.example:4322"],setActive:()=>{},scopes:{open:()=>{}}})
    export const normalizeServerUrl=url=>url
    export const serverDisplayName=url=>url.replace(/^https?:\\/\\//,"")
    export const usePlatform=()=>({platform:"web",fetch:async url=>new Response(JSON.stringify({healthy:!String(url).includes("offline")}),{headers:{"content-type":"application/json"}})})
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
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {SessionWorkContext} from ${JSON.stringify(`/@fs/${source}/components/session/work-context.tsx`)}
    import {DefaultComposer} from ${JSON.stringify(`/@fs/${source}/plugin/default-composer.tsx`)}
    import {state,patch,directories} from "./stubs"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function App(){
      const input={readOnly:()=>false,primaryAction:()=>"send",submit:async()=>{},stop:async()=>{},dragging:()=>false,className:()=>"",current:()=>({mode:"normal"}),setComposing:()=>{},dragOver:()=>{},dragLeave:()=>{},drop:async()=>{},
        editor:{label:()=>"Message",completion:()=>undefined,placeholder:()=>undefined,mount:()=>()=>{},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{}},
        render:part=>part==="leading"?<><div data-extension>Composer extension</div><SessionWorkContext directories={directories()} workspaceSelection={state.selection} running={state.running} disabled={state.disabled} environmentProfile={state.profile} startOptions={[]} onSelect={selection=>{window.fixture.selection=selection;patch("selection",selection)}}><button data-shortcuts>Quick actions</button><span data-agenda>Scheduled wake</span></SessionWorkContext></>:part==="context"?<><button data-attachment>Attachment</button><p data-permission>Permission request</p><p role="alert" data-error>Request failed</p></>:part==="toolbar"?<button type="submit" data-send>Send</button>:null}
      return <div data-pane style={{width:state.width+"px","max-width":"100%"}}><DefaultComposer context={{input}}/></div>
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
  expect(await page.locator(".session-work-context").count()).toBe(1)
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
