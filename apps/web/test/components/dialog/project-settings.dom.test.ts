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

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".project-settings-"))
  const stubs = path.join(fixture, "stubs.ts")
  await Bun.write(
    stubs,
    `
    const h = window.fixture = {writes:[], saved:0, fail:"", hold:false, release:()=>{}, picks:0, refreshes:0, refreshHold:false, refreshFail:false, refreshRelease:()=>{}, refreshed:"main", callbackHold:false, callbackFail:"", callbackRelease:()=>{}}
    let directories={scopeID:"project",revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:["shared"],folders:[
      {workspaceID:"main",path:"/projects/main",generation:1,available:true,git:true},
      {workspaceID:"shared",path:"/projects/shared",generation:1,available:true,git:!location.search.includes("plain")}
    ]}
    let defaults={}
    const result=()=>({defaults,effective:{defaultSessionWorkspace:"main",...defaults},editable:true})
    async function write(section,input){
      h.writes.push({section,input})
      if(h.hold) await new Promise(resolve=>{h.release=()=>{h.hold=false;resolve()}})
      if(h.fail===section) throw new Error("Cannot save "+section)
    }
    const client={scope:{async update(input){await write("name",input);return {data:{name:input.name}}}},project:{
      async directories(){return {data:structuredClone(directories)}},
      async updateDirectories(input){
        await write("folders",input)
        const update=input.projectDirectoriesUpdate
        if(update.revision!==directories.revision) throw new Error("Stale directories")
        directories={...directories,revision:directories.revision+1,folders:update.directories.map(path=>directories.folders.find(folder=>folder.path===path)??{workspaceID:path,generation:1,path,available:true,git:!location.search.includes("new-plain")}),mainWorkspaceID:directories.folders.find(folder=>folder.path===update.mainDirectory)?.workspaceID??update.mainDirectory}
        return {data:structuredClone(directories)}
      },
      taskDefaults:{async get(){return {data:result()}},async update(input){
        await write("defaults",input)
        defaults=structuredClone(input.projectTaskDefaultsInput.defaults)
        return {data:result()}
      }}
    },global:{filesystem:{async directories(input){return {data:{path:input.path,parent:"/",entries:[{name:"extra",path:"/projects/extra"}]}}}}}}
    export const useGlobalSDK=()=>({url:"http://computer.test",client})
    export const useGlobalSync=()=>({data:{paths:{home:"/projects"}},async refreshConfig(scopeID){
      if(scopeID!=="project") throw new Error("Wrong Scope")
      h.refreshes++
      if(h.refreshHold) await new Promise(resolve=>{h.refreshRelease=()=>{h.refreshHold=false;resolve()}})
      if(h.refreshFail) throw new Error("Cannot refresh settings")
      h.refreshed=result().effective.defaultSessionWorkspace
    }})
    export const usePlatform=()=>({platform:"web"})
    export const serverDisplayName=()=>"Test computer"
    export const useComputerLabel=()=>()=>"Test computer"
    export const DialogWorktrees=()=>null
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DialogScopeEdit} from ${JSON.stringify(`/@fs/${source}/components/dialog/dialog-scope-edit.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=> <DialogScopeEdit scope={{id:"project",name:"Original project",expanded:true}} onSaved={()=>{const h=window.fixture;h.saved++;if(h.callbackFail==="throw") throw new Error("Cannot refresh directories");return (async ()=>{if(h.callbackHold) await new Promise(resolve=>{h.callbackRelease=()=>{h.callbackHold=false;resolve()}});if(h.callbackFail==="reject") throw new Error("Cannot refresh directories")})()}}/>)}>Settings</button>}
    render(()=> <ThemeProvider><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider></ThemeProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "project-settings-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "@/context/global-sdk",
              "@/context/global-sync",
              "@/context/platform",
              "@/context/server",
              "./computer-menu",
              "./dialog-worktrees",
            ].includes(id) ||
            /\/context\/(global-sdk|global-sync|platform|server)(\.tsx)?$/.test(id)
          )
            return stubs
        },
      },
      solid(),
      tailwind(),
    ],
    resolve: {
      alias: {
        "@": source,
        "lucide-solid": Bun.resolveSync("lucide-solid", path.resolve(source, "../../../packages/ui")),
      },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "lucide-solid"],
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
  page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

const settings = () => page.getByRole("dialog", { name: "Project settings", exact: true })
const save = () => settings().getByRole("button", { name: "Save", exact: true })
const name = () => settings().getByRole("textbox", { name: "Project name", exact: true })
const start = () => settings().getByRole("button", { name: "New Worktree", exact: true })
async function open(query = "") {
  errors.length = 0
  await page.goto(base + query)
  await page.locator("#open").click()
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>(".project-settings-dialog .project-icon-button")?.disabled,
  )
  expect(errors).toEqual([])
}
async function changeMain() {
  await settings()
    .locator(".project-folder-row")
    .filter({ hasText: "shared" })
    .getByRole("button", { name: "Folder actions" })
    .click()
  await page.getByRole("button", { name: "Set as main folder", exact: true }).click()
}

test("one footer Save commits all edited sections only on confirmation", async () => {
  await open()
  expect(await save().count()).toBe(1)
  expect(
    await settings().locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Save", exact: true }).count(),
  ).toBe(1)
  expect(await save().isDisabled()).toBe(true)
  await name().fill("Renamed project")
  await changeMain()
  await start().click()
  expect(await page.evaluate<unknown[]>("window.fixture.writes")).toEqual([])
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await save().isDisabled()).toBe(true)
  const writes =
    await page.evaluate<Array<{ section: string; input: Record<string, unknown> }>>("window.fixture.writes")
  expect(writes.map((item) => item.section)).toEqual(["folders", "defaults", "name"])
  expect(writes[0]!.input.projectDirectoriesUpdate).toEqual({
    directories: ["/projects/main", "/projects/shared"],
    mainDirectory: "/projects/shared",
    revision: 1,
  })
  expect(writes[1]!.input.projectTaskDefaultsInput).toEqual({
    defaults: { defaultSessionWorkspace: "worktree" },
    expected: {},
  })
  expect(writes[2]!.input.name).toBe("Renamed project")
  expect(await page.evaluate<number>("window.fixture.saved")).toBe(1)
}, 20_000)

test("failed saves retain drafts and retry only the unsaved sections", async () => {
  await open()
  await name().fill("Keep this draft")
  await changeMain()
  await start().click()
  await page.evaluate("window.fixture.fail='defaults'")
  await save().click()
  await settings().getByRole("alert").waitFor()
  expect(await name().inputValue()).toBe("Keep this draft")
  expect(await start().getAttribute("aria-pressed")).toBe("true")
  expect(await settings().innerText()).toContain("Some changes were saved")
  await page.evaluate("window.fixture.fail=''")
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual([
    "folders",
    "defaults",
    "defaults",
    "name",
  ])
}, 20_000)

test("cancel, nested directory picking, and validation never save a draft", async () => {
  await open()
  await name().fill("Draft name")
  await settings().getByRole("button", { name: "Add folder", exact: true }).click()
  const picker = page.getByRole("dialog").last()
  await picker.getByRole("button", { name: "extra", exact: true }).waitFor()
  await picker.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.locator(".directory-navigation").waitFor({ state: "hidden" })
  expect(await name().inputValue()).toBe("Draft name")
  await name().fill("   ")
  expect(await save().isDisabled()).toBe(true)
  await settings().locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Discard changes", exact: true }).click()
  await settings().waitFor({ state: "hidden" })
  expect(await page.evaluate<unknown[]>("window.fixture.writes")).toEqual([])
}, 20_000)

test("a non-Git main folder cannot be saved with a staged Worktree default", async () => {
  await open("?plain")
  await start().click()
  await changeMain()
  expect(await save().isDisabled()).toBe(true)
  expect(await page.evaluate<unknown[]>("window.fixture.writes")).toEqual([])
  expect(await settings().getByRole("alert").innerText()).toContain("Choose Main folder")
  await settings().getByRole("button", { name: "Main folder", exact: true }).click()
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual([
    "folders",
    "defaults",
  ])
}, 20_000)

test("changing folders also validates an already saved Worktree default", async () => {
  await open("?plain")
  await start().click()
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  await changeMain()
  expect(await save().isDisabled()).toBe(true)
  expect(await settings().getByRole("alert").innerText()).toContain("Choose Main folder")
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual(["defaults"])
}, 20_000)

test("a newly added non-Git main folder leaves a saved Worktree default visibly incomplete", async () => {
  await open("?new-plain")
  await start().click()
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  await name().fill("Keep this draft")
  await settings().getByRole("button", { name: "Add folder", exact: true }).click()
  const picker = page.getByRole("dialog").last()
  const extra = picker.getByRole("checkbox", { name: "Select folder: extra", exact: true })
  await extra.press("Space")
  expect(await extra.isChecked()).toBe(true)
  await picker.getByRole("button", { name: "Use selected folders", exact: true }).click()
  await settings()
    .locator(".project-folder-row")
    .filter({ hasText: "extra" })
    .getByRole("button", { name: "Folder actions" })
    .click()
  await page.getByRole("button", { name: "Set as main folder", exact: true }).click()
  await save().click()
  await settings().getByRole("alert").waitFor()
  expect(await settings().getByRole("alert").innerText()).toContain("Choose Main folder")
  expect(await settings().getByRole("status").innerText()).toContain("Some changes were saved: Folders")
  expect(await name().inputValue()).toBe("Keep this draft")
  expect(await save().isDisabled()).toBe(true)
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual([
    "defaults",
    "folders",
  ])
  await settings().getByRole("button", { name: "Main folder", exact: true }).click()
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual([
    "defaults",
    "folders",
    "defaults",
    "name",
  ])
}, 20_000)

test("Saved waits for confirmed configuration and the caller's directory refresh", async () => {
  await open()
  await start().click()
  await page.evaluate("window.fixture.refreshHold=true;window.fixture.callbackHold=true")
  await save().click()
  await page.waitForFunction("window.fixture.refreshes === 1")
  expect(await settings().getByRole("status").innerText()).toBe("")
  expect(await name().isDisabled()).toBe(true)
  await page.keyboard.press("Escape")
  expect(await settings().isVisible()).toBe(true)
  await page.evaluate("window.fixture.refreshRelease()")
  await page.waitForFunction("window.fixture.refreshed === 'worktree'")
  expect(await name().isDisabled()).toBe(true)
  await page.evaluate("window.fixture.callbackRelease()")
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await name().isDisabled()).toBe(false)
}, 20_000)

test("refresh failures retry synchronization without repeating saved writes", async () => {
  await open()
  await start().click()
  await page.evaluate("window.fixture.refreshFail=true")
  await save().click()
  await settings().getByRole("alert").waitFor()
  expect(await settings().getByRole("status").innerText()).toContain("could not be loaded")
  expect(await save().isDisabled()).toBe(false)
  await page.evaluate("window.fixture.refreshFail=false")
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<string>("window.fixture.refreshed")).toBe("worktree")
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual(["defaults"])
}, 20_000)

test.each(["config", "callback rejection", "callback throw"])(
  "a %s failure keeps saving locked until the other refresh settles",
  async (failure) => {
    await open()
    await start().click()
    await page.evaluate((failure) => {
      Object.assign(
        Reflect.get(window, "fixture"),
        failure === "config"
          ? { refreshFail: true, callbackHold: true }
          : { refreshHold: true, callbackFail: failure === "callback throw" ? "throw" : "reject" },
      )
    }, failure)
    await save().click()
    await page.waitForFunction("window.fixture.refreshes === 1 && window.fixture.saved === 1")
    expect(await name().isDisabled()).toBe(true)
    expect(await settings().getByRole("status").innerText()).toBe("")
    await page.keyboard.press("Escape")
    expect(await settings().isVisible()).toBe(true)
    await page.evaluate("window.fixture.refreshRelease();window.fixture.callbackRelease()")
    await settings().getByRole("alert").waitFor()
    expect(await name().isDisabled()).toBe(false)
    expect(await save().isDisabled()).toBe(false)
    expect(await settings().getByRole("status").innerText()).toContain("could not be loaded")
    expect(errors).toEqual([])
  },
  20_000,
)

test("reloading a partial save retains synchronization retry without rewriting saved sections", async () => {
  await open()
  await start().click()
  await name().fill("Unsaved name")
  await page.evaluate("window.fixture.fail='name';window.fixture.refreshFail=true")
  await save().click()
  await settings().getByRole("alert").filter({ hasText: "Cannot refresh settings" }).waitFor()
  await name().fill("Original project")
  await settings().getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>(".project-settings-dialog .project-icon-button")?.disabled,
  )
  expect(await save().isDisabled()).toBe(false)
  await page.evaluate("window.fixture.fail='';window.fixture.refreshFail=false")
  await save().click()
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<string>("window.fixture.refreshed")).toBe("worktree")
  expect(await page.evaluate<string[]>("window.fixture.writes.map(item=>item.section)")).toEqual(["defaults", "name"])
}, 20_000)

test("saving locks the form and rejects repeated submit", async () => {
  await open()
  await name().fill("Pending name")
  await page.evaluate("window.fixture.hold=true")
  await save().click()
  await page.waitForFunction("window.fixture.writes.length === 1")
  expect(await name().isDisabled()).toBe(true)
  expect(
    await settings()
      .locator('[data-slot="dialog-footer"]')
      .getByRole("button", { name: "Cancel", exact: true })
      .isDisabled(),
  ).toBe(true)
  await page.keyboard.press("Escape")
  expect(await settings().isVisible()).toBe(true)
  await page.evaluate("window.fixture.release()")
  await settings().getByRole("status").filter({ hasText: "Saved" }).waitFor()
  expect(await page.evaluate<number>("window.fixture.writes.length")).toBe(1)
}, 20_000)

test("selection is distinct from hover and keyboard focus stays neutral in both themes at narrow widths", async () => {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.setViewportSize({ width: 375, height: 568 })
    await open()
    await start().click()
    await page.mouse.move(0, 0)
    expect(await start().getAttribute("aria-pressed")).toBe("true")
    expect(await start().locator('[data-component="icon"]').isVisible()).toBe(true)
    const selected = await start().evaluate((element) => getComputedStyle(element).backgroundColor)
    const main = settings().getByRole("button", { name: "Main folder", exact: true })
    await main.hover()
    const hovered = await main.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(selected).not.toBe("rgba(0, 0, 0, 0)")
    expect(selected).not.toBe(hovered)
    await name().focus()
    const focus = await name().evaluate((element) => {
      const wrapper = element.closest('[data-slot="input-wrapper"]')!
      const style = getComputedStyle(wrapper)
      const rgb = style.outlineColor
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
      return { width: parseFloat(style.outlineWidth), chroma: Math.max(...rgb) - Math.min(...rgb) }
    })
    expect(focus.width).toBeGreaterThanOrEqual(2)
    expect(focus.chroma).toBeLessThan(20)
    const footer = await settings().locator('[data-slot="dialog-footer"]').boundingBox()
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(568)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  }
}, 30_000)
