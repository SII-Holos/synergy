import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
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
  fixture = await mkdtemp(path.join(import.meta.dir, ".workspace-dialog-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    import {createSignal} from "solid-js"
    const [current,setCurrent]=createSignal(true)
    const record = (id, p, state="bound") => ({id,scopeID:"scope",type:"directory",revision:1,binding:{hostID:"host",path:p,generation:1,state,physicalID:state==="bound" ? "physical:"+id : undefined},metadata:{},sharedWritableWorkspaceIDs:[],lifecycle:"active",createdAt:1,updatedAt:1})
    const rows=[record("wsp_a","/first"),record("wsp_b","/second"),record("wsp_history","/foreign","unbound"),record("wsp_unverified","/unverified")]
    delete rows[3].binding.physicalID
    rows.push({...record("wsp_objects",null), backend:{provider:"objects",spec:{}},type:"objects",metadata:{name:"Research"}})
    const listeners = new Set()
    const requests=[]
    const h=window.fixture={ requests, rows, selected:[], fail:false, pick:"/new", sessions:[{id:"session",title:"Project task",workspaceID:"wsp_a"}],registerError:null,registerID:null,rebindError:null,isCurrent:current,expire:()=>setCurrent(false),emit(record){listeners.forEach(fn=>fn({properties:record}))} }
    export const useSDK=()=>({scopeID:"scope",client:{environment:{async profiles(){return {data:{defaultEnvironment:"native",environments:[{name:"native",provider:"native"},{name:"remote",provider:"remote"}],stores:[{name:"local",provider:"local"}]}}}},workspace:{
      async createObjects(input){requests.push({kind:"objects",...input});const next={...record("wsp_created",null),type:"objects",backend:{provider:"objects",spec:{}},metadata:{name:input.name}}; rows.push(next);return {data:next}},
      async list(){return {data:structuredClone(rows)}},
      async recoverSaved(input){requests.push({kind:"recover-saved",...input});if(h.fail)throw new Error("Workspace changed before recovery");const next={...rows.find(row=>row.id===input.workspaceID),id:"wsp_recovered",activeMount:undefined,metadata:{name:"Recovered"}};rows.push(next);return {data:next}},
      async register(input){requests.push({kind:"register",...input});if(h.registerError)throw h.registerError;if(h.registerID)return {data:structuredClone(rows.find(row=>row.id===h.registerID))};const next=record("wsp_new",input.path);rows.push(next);return {data:next}},
      async setSharing(input){requests.push({kind:"share",...input});if(h.fail)throw new Error("Workspace changed before sharing");const row=rows.find(row=>row.id===input.workspaceID);row.revision++;row.sharedWritableWorkspaceIDs=input.workspaceIDs;return {data:structuredClone(row)}},
      async rebind(input){requests.push({kind:"rebind",...input});if(h.rebindError)throw h.rebindError;const row=rows.find(row=>row.id===input.workspaceID);row.revision++;row.binding={...row.binding,state:"bound",path:input.path,physicalID:"physical:"+row.id,generation:row.binding.generation+1};return {data:structuredClone(row)}}},
      session:{async list(input){requests.push({kind:"sessions",...input});return {data:{data:h.sessions.slice(input.offset,input.offset+input.limit),total:h.sessions.length}}},async selectWorkspace(input){requests.push({kind:"select",...input});if(h.fail)throw new Error("Session is busy");return {data:{}}}}},
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
    import {ConfirmDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/dialog/confirm-dialog.tsx`)}
    import {DialogWorkspace} from ${JSON.stringify(`/@fs/${appSrc}/components/dialog/dialog-workspace.tsx`)}
    import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
    function App(){const dialog=useDialog();return <><button id="long-confirm" onClick={()=>dialog.show(()=><ConfirmDialog title="Confirm directory" description={Array.from({length:200},(_,n)=>"Long destination "+n+" "+"x".repeat(80)).join("\\n")} confirmLabel="Apply directory" tone="warning" onConfirm={()=>window.fixture.selected.push("confirmed")}/>)}>Long confirmation</button><button id="copies" onClick={()=>dialog.show(()=><DialogWorkspace copiesOnly target={{kind:"draft",selection:{mode:"current"},onSelect:value=>window.fixture.selected.push(value)}}/>)}>Choose a Worktree</button><button id="existing" onClick={()=>dialog.show(()=><DialogWorkspace copiesOnly target={{kind:"draft",selection:{mode:"existing",target:window.fixture.existingTarget},onSelect:value=>window.fixture.selected.push(value)}}/>)}>Continue existing Worktree</button><button id="manager" onClick={()=>dialog.show(()=><DialogWorkspace mode="manage"/>)}>Manage directories</button><button id="draft" onClick={()=>dialog.show(()=><DialogWorkspace target={{kind:"draft",selection:{mode:"workspace",workspaceID:"wsp_b",workspaceGeneration:1},onSelect:value=>window.fixture.selected.push(value)}}/>)}>Choose for draft</button><button id="recover" onClick={()=>dialog.show(()=><DialogWorkspace mode="recover" recovery={{workspaceID:"wsp_unverified",reason:"identity_unverified",isCurrent:()=>window.fixture.isCurrent()}} target={{kind:"draft",onSelect:value=>window.fixture.selected.push(value)}}/>)}>Recover draft</button><button id="recover-session" onClick={()=>dialog.show(()=><DialogWorkspace mode="recover" recovery={{workspaceID:"wsp_unverified"}} target={{kind:"session",sessionID:"created-session",onApplied:value=>window.fixture.selected.push(value)}}/>)}>Recover created session</button><button id="select-remote" onClick={()=>dialog.show(()=><DialogWorkspace mode="select" environmentProfile="remote" target={{kind:"draft",onSelect:value=>window.fixture.selected.push(value)}}/>)}>Remote files</button><button id="open" onClick={()=>dialog.show(()=><DialogWorkspace target={{kind:"session",sessionID:"session"}}/>)}>Open</button></>}
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
      tailwind(),
    ],
    resolve: {
      alias: {
        "@": appSrc,
        "lucide-solid": Bun.resolveSync("lucide-solid", path.resolve(appSrc, "../../../packages/ui")),
      },
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "lucide-solid"],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      watch: null,
      fs: { allow: [path.resolve(appSrc, "../../.."), fixture] },
    },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  const preparation = await browser.newPage()
  try {
    await preparation.goto(base, { timeout: 20_000 })
    await preparation.locator("#recover").waitFor({ timeout: 4000 })
  } finally {
    await preparation.close()
  }
}, 30_000)
beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(4000)
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

const workspaceRow = (id: string) => page.locator(`[data-workspace-id="${id}"]`)

async function manage() {
  await page.getByRole("button", { name: "Manage", exact: true }).click()
  await page.locator("summary").filter({ hasText: "Tasks using these files" }).waitFor()
}

async function open() {
  errors.length = 0
  await page.goto(base)
  await page.locator("#open").click()
  await workspaceRow("wsp_a").waitFor()
  expect(errors).toEqual([])
}

test("draft directory recovery applies a choice without creating or sending a task", async () => {
  await page.goto(base)
  await page.locator("#recover").click()
  await workspaceRow("wsp_b").click()
  const footer = page.locator('[data-slot="dialog-footer"]')
  expect(await footer.getByRole("button").count()).toBe(2)
  await footer.getByRole("button").last().click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([
    { mode: "workspace", workspaceID: "wsp_b", workspaceGeneration: 1 },
  ])
  expect(await page.evaluate<unknown[]>("window.fixture.requests")).toEqual([])
}, 20_000)

test.each(["wsp_b", "tree_b", "/second"])(
  "an existing Worktree target stays selected when reopening the directory chooser (%s)",
  async (target) => {
    await page.goto(base)
    await page.evaluate((value) => {
      const fixture = (
        window as unknown as {
          fixture: { existingTarget: string; rows: { type: string; metadata: { worktreeID?: string } }[] }
        }
      ).fixture
      fixture.existingTarget = value
      fixture.rows[1]!.type = "git_worktree"
      fixture.rows[1]!.metadata.worktreeID = "tree_b"
    }, target)
    await page.locator("#existing").click()
    await workspaceRow("wsp_b").waitFor()
    expect(await workspaceRow("wsp_b").getAttribute("aria-pressed")).toBe("true")
    expect(await workspaceRow("wsp_b").textContent()).toContain("Currently used")
    await page.getByRole("button", { name: "Use this directory", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([
      { mode: "workspace", workspaceID: "wsp_b", workspaceGeneration: 1 },
    ])
    expect(await page.evaluate<unknown[]>("window.fixture.requests")).toEqual([])
  },
  20_000,
)

test("a copies-only chooser cannot confirm a hidden main directory", async () => {
  await page.goto(base)
  await page.locator("#copies").click()
  const apply = page.locator('[data-slot="dialog-footer"] button').last()
  await apply.waitFor()
  expect(await workspaceRow("wsp_a").count()).toBe(0)
  expect(await apply.isDisabled()).toBe(true)
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
}, 20_000)

test("an unresolved existing Worktree requires an explicit replacement", async () => {
  await page.goto(base)
  await page.evaluate("window.fixture.existingTarget='missing-tree'")
  await page.locator("#existing").click()
  const apply = page.locator('[data-slot="dialog-footer"] button').last()
  await apply.waitFor()
  expect(await apply.isDisabled()).toBe(true)
  await page.getByRole("button", { name: "No project files", exact: true }).click()
  await page.getByRole("button", { name: "Use no project files", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([{ mode: "none" }])
}, 20_000)

test("expired recovery closes without applying to another connection or project", async () => {
  await page.goto(base)
  await page.locator("#recover").click()
  await workspaceRow("wsp_b").click()
  await page.evaluate("window.fixture.expire()")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
  expect(await page.evaluate<unknown[]>("window.fixture.requests")).toEqual([])
}, 20_000)

test.each(["#recover", "#recover-session"])(
  "recovery distinguishes the current location from the failed binding (%s)",
  async (trigger) => {
    await page.goto(base)
    await page.locator(trigger).click()
    await workspaceRow("wsp_a").waitFor()
    expect(await workspaceRow("wsp_a").textContent()).toContain("Currently used")
    expect(await workspaceRow("wsp_unverified").textContent()).not.toContain("Currently used")
  },
  20_000,
)

test("an expired recovery cannot close the dialog that replaces it", async () => {
  await page.goto(base)
  await page.locator("#recover").click()
  await workspaceRow("wsp_b").waitFor()
  await page.evaluate(() => {
    document.getElementById("manager")!.click()
    ;(window as unknown as { fixture: { expire: () => void } }).fixture.expire()
  })
  const manager = page.getByRole("dialog", { name: "Manage files and copies", exact: true })
  await manager.waitFor()
  await page.waitForTimeout(100)
  expect(await manager.isVisible()).toBe(true)
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
}, 20_000)

test("recovery uses the created session identity and returns its draft only after selection succeeds", async () => {
  await page.goto(base)
  await page.locator("#recover-session").click()
  await workspaceRow("wsp_b").click()
  await page.evaluate("window.fixture.fail=true")
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "select",
    sessionID: "created-session",
  })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([
    { mode: "workspace", workspaceID: "wsp_b", workspaceGeneration: 1 },
  ])
}, 20_000)

test("equal directory names retain their paths and branch search", async () => {
  await open()
  await page.evaluate(
    `for(const row of window.fixture.rows.slice(0,2))window.fixture.emit({...row,revision:2,metadata:{name:"synergy",branch:row.id==="wsp_a"?"feature/first":"feature/second"}})`,
  )
  const rows = page.locator('[aria-label="Choose a working directory"] button').filter({ hasText: "synergy" })
  expect(await rows.count()).toBe(2)
  expect(await rows.first().textContent()).toContain("/first")
  expect(await rows.last().textContent()).toContain("/second")
  await page.getByLabel("Search directories").fill("feature/second")
  expect(await rows.count()).toBe(1)
  expect(await rows.first().textContent()).toContain("/second")
}, 20_000)

test("a background rebind requires selecting the new generation explicitly", async () => {
  await open()
  await page.evaluate(
    "const row=window.fixture.rows[0];window.fixture.emit({...row,revision:2,binding:{...row.binding,path:'/changed',generation:2}})",
  )
  expect(await page.locator('[data-slot="dialog-footer"] button').last().isDisabled()).toBe(true)
  await workspaceRow("wsp_a").click()
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_a", workspaceGeneration: 2 },
  })
}, 20_000)

test("the flat list keeps current and main directories first and selection does not reorder it", async () => {
  await page.goto(base)
  await page.locator("#draft").click()
  await workspaceRow("wsp_b").waitFor()
  const order = () =>
    page.locator("[data-workspace-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-workspace-id")))
  const expected = ["wsp_b", "wsp_a", "wsp_objects", "wsp_history", "wsp_unverified"]
  expect(await order()).toEqual(expected)
  await workspaceRow("wsp_objects").click()
  expect(await order()).toEqual(expected)
  expect(await workspaceRow("wsp_objects").getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).last().click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
  expect(await page.evaluate<unknown[]>("window.fixture.requests")).toEqual([])
}, 20_000)

test("directory management has an explicit close action without applying a selection", async () => {
  await page.goto(base)
  await page.locator("#manager").click()
  await workspaceRow("wsp_b").click()
  const footer = page.locator('[data-slot="dialog-footer"]')
  expect(await footer.getByRole("button").count()).toBe(1)
  await footer.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([])
  expect(await page.evaluate<unknown[]>("window.fixture.requests")).toEqual([])
}, 20_000)

test("the confirmation remains visible with long paths and a long list in narrow and short windows", async () => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 400 },
  ]) {
    await page.setViewportSize(viewport)
    await open()
    await page.evaluate(
      "const row=window.fixture.rows[1];for(let n=0;n<30;n++)window.fixture.emit({...row,id:'long_'+n,metadata:{name:'A very long directory name that must remain readable'},binding:{...row.binding,path:'/projects/a-very-long-parent-directory-with-no-spaces-to-wrap/working-directory-'+n}})",
    )
    const confirmation = page.getByRole("button", { name: "Use this directory", exact: true })
    await page.getByRole("dialog").evaluate((element) =>
      Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      ),
    )
    const before = await confirmation.boundingBox()
    expect(before).not.toBeNull()
    expect(before!.x).toBeGreaterThanOrEqual(0)
    expect(before!.x + before!.width).toBeLessThanOrEqual(viewport.width)
    expect(before!.y + before!.height).toBeLessThanOrEqual(viewport.height)
    await page.locator('[data-slot="dialog-body"]').evaluate((element) => (element.scrollTop = element.scrollHeight))
    const after = await confirmation.boundingBox()
    expect(after!.y).toBeCloseTo(before!.y, 0)
    await workspaceRow("long_9").click()
    await confirmation.click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
      sessionWorkspaceSelection: { workspaceID: "long_9" },
    })
  }
  await page.setViewportSize({ width: 375, height: 812 })
}, 30_000)

test("selecting a Workspace preserves Scope and reports busy failures without dismissing", async () => {
  await open()
  await workspaceRow("wsp_b").click()
  await page.evaluate("window.fixture.fail=true")
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.getByRole("alert").textContent()).toContain("Session is busy")
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    scopeID: "scope",
    sessionID: "session",
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_b", workspaceGeneration: 1 },
  })
  expect(errors).toEqual([])
}, 20_000)

test("reload and adding files ask before discarding unsaved sharing", async () => {
  await open()
  await manage()
  await page.locator('[data-slot="checkbox-checkbox-label"]').filter({ hasText: "/second" }).click()
  for (const action of ["Refresh list", "Add directory"]) {
    await page.getByRole("button", { name: action, exact: true }).click()
    await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click()
    expect(await page.getByRole("checkbox", { name: /\/second/ }).isChecked()).toBe(true)
  }
  expect(await workspaceRow("wsp_new").count()).toBe(0)
}, 20_000)

test("lost file views recover a separate saved copy with the observed revision", async () => {
  await open()
  await page.evaluate(
    "window.fixture.rows[4].activeMount={state:'unavailable'};window.fixture.emit(window.fixture.rows[4])",
  )
  await workspaceRow("wsp_objects").click()
  expect(await page.getByRole("button", { name: "Use this file collection", exact: true }).isDisabled()).toBe(true)
  await manage()
  await page.evaluate("window.fixture.emit({...window.fixture.rows[4],revision:2});window.fixture.fail=true")
  await page.getByRole("button", { name: "Recover saved copy", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "recover-saved",
    workspaceID: "wsp_objects",
    expectedRevision: 1,
    profile: "local",
  })
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Refresh list", exact: true }).click()
  await page.getByRole("button", { name: "Recover saved copy", exact: true }).click()
  await workspaceRow("wsp_recovered").waitFor()
  expect(await page.getByRole("button", { name: "Use this file collection", exact: true }).isEnabled()).toBe(true)
  expect(await page.evaluate<string>("window.fixture.rows[4].activeMount.state")).toBe("unavailable")
  expect(errors).toEqual([])
}, 20_000)

test("sharing keeps its original revision after an external update and new directories can be selected", async () => {
  await open()
  await manage()
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
  expect(await page.getByRole("checkbox", { name: /\/second/ }).isChecked()).toBe(true)
  await page.evaluate("window.fixture.fail=false")
  await page.getByRole("button", { name: "Add directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Discard changes", exact: true }).click()
  await workspaceRow("wsp_new").waitFor()
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "select",
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_new", workspaceGeneration: 1 },
  })
  expect(errors).toEqual([])
}, 20_000)

test("unbound history needs an explicit rebind and Escape returns focus", async () => {
  await open()
  await workspaceRow("wsp_history").click()
  expect(await page.getByRole("button", { name: "Use this directory", exact: true }).isDisabled()).toBe(true)
  await manage()
  await page.getByLabel("New local directory", { exact: true }).fill("/rebound")
  await page.evaluate("window.fixture.emit({...window.fixture.rows[2],revision:2})")
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByText("/rebound", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Use this directory", exact: true }).isEnabled()).toBe(true)
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

test("a bound directory without a verified identity requires rebind before selection or sharing", async () => {
  await open()
  expect(await page.getByRole("checkbox", { name: "/unverified", exact: true }).count()).toBe(0)
  await workspaceRow("wsp_unverified").click()
  expect(await page.getByRole("button", { name: "Use this directory", exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Save sharing", exact: true }).count()).toBe(0)
  await manage()
  await page.getByLabel("New local directory", { exact: true }).fill("/verified")
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByText("/verified", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "select",
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_unverified", workspaceGeneration: 2 },
  })
  expect(errors).toEqual([])
}, 20_000)

test("stored Workspaces can be selected and created without a directory picker", async () => {
  await open()
  await workspaceRow("wsp_objects").click()
  expect(await page.getByRole("button", { name: "Use this file collection", exact: true }).isEnabled()).toBe(true)
  expect(await page.getByText("Change local directory", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Save sharing", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Use this file collection", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "select",
    sessionWorkspaceSelection: { mode: "workspace", workspaceID: "wsp_objects", workspaceGeneration: 1 },
  })
  await page.locator("#open").click()
  await manage()
  await page.getByRole("button", { name: "Create stored Workspace", exact: true }).click()
  await page.getByLabel("Workspace name", { exact: true }).fill("Experiment")
  await page.getByRole("button", { name: "Create Workspace", exact: true }).click()
  await workspaceRow("wsp_created").waitFor()
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "objects",
    profile: "local",
    name: "Experiment",
  })
  expect(await page.evaluate<boolean>("window.fixture.requests.some(r=>r.kind==='register')")).toBe(false)
  expect(errors).toEqual([])
}, 20_000)

test("remote execution offers file collections without browsing the service's local folders", async () => {
  await page.goto(base)
  await page.locator("#select-remote").click()
  const browse = page.getByRole("button", { name: "Add directory", exact: true })
  await browse.waitFor()
  expect(await browse.isDisabled()).toBe(true)
  expect(
    await page
      .getByText("Use a file collection for this execution location; its folders cannot be browsed here.", {
        exact: true,
      })
      .isVisible(),
  ).toBe(true)
  await workspaceRow("wsp_objects").click()
  await page.getByRole("button", { name: "Use this file collection", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.selected.at(-1)")).toMatchObject({ workspaceID: "wsp_objects" })
}, 20_000)

async function expectWithinViewport(control: ReturnType<Page["getByRole"]>) {
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}

test("recovery keeps the failed project ahead of hundreds of historical copies", async () => {
  await page.goto(base)
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: { rows: Record<string, unknown>[] } }).fixture
    for (let n = 0; n < 300; n++)
      h.rows.push({ ...h.rows[0], id: `copy_${n}`, type: "git_worktree", metadata: { name: `Old copy ${n}` } })
  })
  await page.locator("#recover").click()
  await workspaceRow("wsp_unverified").waitFor()
  expect(await page.locator("[data-workspace-id]").first().getAttribute("data-workspace-id")).toBe("wsp_unverified")
  expect(await page.locator('[data-workspace-id^="copy_"]').count()).toBe(0)
  await page.getByLabel("Search directories").fill("Old copy 299")
  await workspaceRow("copy_299").waitFor()
  expect(await workspaceRow("copy_299").isVisible()).toBe(true)
}, 20_000)

test("hundreds of affected tasks never push binding controls or confirmation offscreen", async () => {
  await page.setViewportSize({ width: 375, height: 560 })
  await page.goto(base)
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: { sessions: unknown[] } }).fixture
    h.sessions = Array.from({ length: 230 }, (_, n) => ({
      id: `task_${n}`,
      title: `Historical task ${n} with a long title that wraps across several lines`,
      workspaceID: "wsp_a",
    }))
  })
  await page.locator("#open").click()
  await manage()
  await expectWithinViewport(page.getByLabel("New local directory", { exact: true }))
  await page.getByLabel("New local directory", { exact: true }).fill("/verified-project")
  const apply = page.getByRole("button", { name: "Confirm directory", exact: true })
  await expectWithinViewport(apply)
  await apply.click()
  const confirmation = page.getByRole("dialog").last()
  const confirm = confirmation.getByRole("button", { name: "Confirm directory", exact: true })
  await confirm.waitFor()
  await expectWithinViewport(confirm)
  expect(await confirmation.textContent()).toContain("/verified-project")
  expect(await confirmation.textContent()).toContain("230")
  expect(await confirmation.textContent()).not.toContain("Historical task 229")
  await confirm.click()
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate("window.fixture.requests.at(-1)")).toMatchObject({
    kind: "select",
    sessionWorkspaceSelection: { workspaceID: "wsp_a", workspaceGeneration: 2 },
  })
}, 20_000)

test.each([false, true])(
  "adding an existing unavailable directory opens explicit repair (conflict=%s)",
  async (conflict) => {
    await page.goto(base)
    await page.evaluate((conflict) => {
      const h = (window as unknown as { fixture: { pick: string; registerID: string; registerError: unknown } }).fixture
      h.pick = "/unverified"
      h.registerID = "wsp_unverified"
      if (conflict)
        h.registerError = {
          name: "WorkspaceUnavailable",
          data: {
            workspaceID: "wsp_unverified",
            reason: "identity_changed",
            message: "The directory was replaced; explicitly rebind this Workspace",
          },
        }
    }, conflict)
    await page.locator("#recover").click()
    await page.getByRole("button", { name: "Add directory", exact: true }).click()
    await page.getByLabel("New local directory", { exact: true }).waitFor()
    expect(await page.getByLabel("New local directory", { exact: true }).inputValue()).toBe("/unverified")
    expect(await page.evaluate<boolean>("window.fixture.requests.some(r=>r.kind==='rebind')")).toBe(false)
    await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
    await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).click()
    await page.getByRole("button", { name: "Use this directory", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([
      { mode: "workspace", workspaceID: "wsp_unverified", workspaceGeneration: 2 },
    ])
  },
  20_000,
)

test("long confirmations scroll their description and keep both actions reachable", async () => {
  await page.setViewportSize({ width: 375, height: 400 })
  await page.goto(base)
  await page.locator("#long-confirm").click()
  const confirm = page.getByRole("button", { name: "Apply directory", exact: true })
  await confirm.waitFor()
  await expectWithinViewport(confirm)
  await expectWithinViewport(page.getByRole("button", { name: "Cancel", exact: true }))
  await page
    .getByRole("dialog")
    .locator('[data-slot="dialog-body"]')
    .evaluate((element) => (element.scrollTop = element.scrollHeight))
  await expectWithinViewport(confirm)
  await confirm.click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual(["confirmed"])
}, 20_000)

test("rebind failure retains the chosen directory and cancel sends no binding mutation", async () => {
  await page.goto(base)
  await page.locator("#recover").click()
  await page.getByRole("button", { name: "Reconnect directory", exact: true }).click()
  await page.getByLabel("New local directory", { exact: true }).fill("/chosen-project")
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click()
  expect(await page.evaluate<boolean>("window.fixture.requests.some(r=>r.kind==='rebind')")).toBe(false)
  expect(await page.getByLabel("New local directory", { exact: true }).inputValue()).toBe("/chosen-project")
  await page.evaluate(
    "window.fixture.rebindError={name:'WorkspaceBusy',data:{message:'This directory is still in use'}}",
  )
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.getByRole("alert").textContent()).toContain("still in use")
  await expectWithinViewport(page.getByRole("alert"))
  expect(await page.getByLabel("New local directory", { exact: true }).inputValue()).toBe("/chosen-project")
  await page.evaluate("window.fixture.rebindError=null")
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("button", { name: "Use this directory", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<unknown[]>("window.fixture.selected")).toEqual([
    { mode: "workspace", workspaceID: "wsp_unverified", workspaceGeneration: 2 },
  ])
}, 20_000)

test("refresh does not authorize a failed binding and expiration cancels its confirmation", async () => {
  await page.goto(base)
  await page.locator("#recover").click()
  await page.getByRole("button", { name: "Refresh list", exact: true }).click()
  expect(await page.getByRole("button", { name: "Use this directory", exact: true }).isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Reconnect directory", exact: true }).click()
  await page.getByRole("button", { name: "Confirm directory", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Confirm directory", exact: true }).waitFor()
  await page.evaluate("window.fixture.expire()")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate<boolean>("window.fixture.requests.some(r=>r.kind==='rebind')")).toBe(false)
}, 20_000)
