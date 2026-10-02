import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import type { DialogSelectDirectoryResult } from "../../../src/components/dialog/dialog-select-directory"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".directory-navigation-"))
  const stubs = path.join(fixture, "stubs.ts")
  await Bun.write(
    stubs,
    `
    const h = window.fixture = {requests:[], selected:[], hold:"", release:()=>{}}
    const client = {global:{filesystem:{
      async directories(input, options) {
        h.requests.push(input)
        if(input.path === h.hold) await new Promise((resolve,reject)=>{
          h.release=resolve
          options.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true})
        })
        if(input.path === "/missing") throw {data:{code:"not_found"}}
        const names = input.path === "/projects" ? ["alpha","beta",...(input.hidden?[".hidden"]:[])] : []
        return {data:{path:input.path,parent:input.path === "/" ? null : "/",entries:names.map(name=>({name,path:input.path+"/"+name}))}}
      },
      async browse(input) {h.requests.push(input);return {data:[input.path+"/alpha"]}}
    }}}
    export const useGlobalSDK=()=>({url:"http://computer.test",client})
    export const useGlobalSync=()=>({data:{paths:{home:"/projects"}}})
    export const usePlatform=()=>({platform:"web"})
    export const serverDisplayName=()=>"Test computer"
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {createSignal} from "solid-js"
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Dialog} from "@ericsanchezok/synergy-ui/dialog"
    import {TextField} from "@ericsanchezok/synergy-ui/text-field"
    import {DialogSelectDirectory} from ${JSON.stringify(`/@fs/${source}/components/dialog/dialog-select-directory.tsx`)}
    import {ProjectFolderFields} from ${JSON.stringify(`/@fs/${source}/components/dialog/project-folder-fields.tsx`)}
    import {useProjectDirectoryPicker} from ${JSON.stringify(`/@fs/${source}/components/dialog/project-directory-picker.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function Parent(){
      const dialog=useDialog();const picker=useProjectDirectoryPicker();const [folders,setFolders]=createSignal([]);const [picking,setPicking]=createSignal(false)
      const browse=()=>dialog.push(()=> <DialogSelectDirectory multiple={!location.search.includes("single")} onSelect={value=>{window.fixture.selected.push(value);if(value)setFolders(Array.isArray(value.directory)?value.directory:[value.directory])}}/>)
      const add=async()=>{setPicking(true);try{const result=await picker.pickProjectDirectories({title:"Choose folders",multiple:true});if(result){window.fixture.selected.push({directory:result.directoryPaths});setFolders(result.directoryPaths)}}finally{setPicking(false)}}
      return <Dialog title="New project"><TextField label="Project name" defaultValue="Draft project"/>{location.search.includes("fields")?<ProjectFolderFields folders={folders()} main={folders()[0]} disabled={picking()} onChange={setFolders} onAdd={add}/>:<button id="browse" onClick={browse}>Browse folders</button>}</Dialog>
    }
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=><Parent/>)}>New project</button>}
    render(()=> <I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "directory-navigation-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            ["@/context/global-sdk", "@/context/global-sync", "@/context/server", "@/context/platform"].includes(id) ||
            /\/context\/(global-sdk|global-sync|server|platform)(\.tsx)?$/.test(id)
          )
            return stubs
        },
      },
      solid(),
      tailwind(),
    ],
    resolve: { alias: { "@": source } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
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

const top = () => page.getByRole("dialog").last()
const editor = () => top().getByRole("textbox", { name: "Folder path", exact: true })
const edit = () => top().getByRole("button", { name: "Edit path", exact: true })

async function selectFolder(name: string) {
  const checkbox = page.getByRole("checkbox", { name: `Select folder: ${name}`, exact: true })
  await top()
    .locator('[data-component="checkbox"]')
    .filter({ has: checkbox })
    .locator('[data-slot="checkbox-checkbox-control"]')
    .click()
}

async function open(query = "") {
  errors.length = 0
  await page.goto(base + query)
  await page.locator("#open").click()
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Keep this draft")
  if (query.includes("fields")) await page.getByRole("button", { name: "Choose folders", exact: true }).click()
  else await page.locator("#browse").click()
  await top().getByRole("button", { name: "alpha", exact: true }).waitFor()
  expect(errors).toEqual([])
}

test("path navigation shows one current location and Escape cancels editing within the folder dialog", async () => {
  await open()
  const current = top().getByRole("navigation", { name: "Current folder", exact: true })
  expect(await current.locator('[aria-current="page"]').innerText()).toBe("projects")
  expect(await editor().count()).toBe(0)
  await edit().click()
  expect(await editor().inputValue()).toBe("/projects")
  await editor().fill("/different")
  await editor().press("Escape")
  await editor().waitFor({ state: "detached" })
  expect(await edit().evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await page.locator('[role="dialog"]').count()).toBe(2)
  await page.keyboard.press("Escape")
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  expect(await page.getByRole("textbox", { name: "Project name" }).inputValue()).toBe("Keep this draft")
  await page.waitForFunction(() => document.activeElement?.id === "browse")
}, 20_000)

test("submitted paths return to navigation while late results preserve newer path edits and failures can recover", async () => {
  await open()
  await edit().click()
  await page.evaluate("window.fixture.hold='/pending'")
  await editor().fill("/pending")
  await editor().press("Enter")
  await top().getByRole("status").filter({ hasText: "Loading folders" }).waitFor()
  await editor().fill("/newer")
  await page.evaluate("window.fixture.release()")
  await top().getByText("This folder has no subfolders. You can use this folder.", { exact: true }).waitFor()
  expect(await editor().inputValue()).toBe("/newer")
  await editor().fill("/missing")
  await editor().press("Enter")
  await top().getByRole("alert").waitFor()
  expect(await editor().inputValue()).toBe("/missing")
  expect(await top().getByRole("button", { name: "Use selected folders", exact: true }).isDisabled()).toBe(true)
  await editor().fill("/projects")
  await editor().press("Enter")
  await editor().waitFor({ state: "detached" })
  expect(await edit().evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await top().getByRole("alert").count()).toBe(0)
  expect(await top().getByRole("button", { name: "alpha", exact: true }).isVisible()).toBe(true)
}, 20_000)

test("multi-selection stays distinct from navigation and restores the originating project draft", async () => {
  await open()
  const confirm = top().getByRole("button", { name: "Use selected folders", exact: true })
  expect(await confirm.isDisabled()).toBe(true)
  await selectFolder("alpha")
  await selectFolder("beta")
  await top().getByRole("button", { name: "alpha", exact: true }).click()
  await top().getByText("This folder has no subfolders. You can use this folder.", { exact: true }).waitFor()
  expect(await top().getByText("2 folders selected", { exact: true }).isVisible()).toBe(true)
  await confirm.click()
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  expect(await page.evaluate<DialogSelectDirectoryResult[]>("window.fixture.selected")).toEqual([
    { directory: ["/projects/alpha", "/projects/beta"] },
  ])
  expect(await page.getByRole("textbox", { name: "Project name" }).inputValue()).toBe("Keep this draft")
  expect(errors).toEqual([])
}, 20_000)

test("shrinking an open picker keeps the current folder visible without losing selection or the parent draft", async () => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await open()
  await selectFolder("alpha")
  await edit().click()
  await editor().fill("/projects/team/research/working-files/current-project-folder-with-a-long-name")
  await editor().press("Enter")
  await editor().waitFor({ state: "detached" })
  await page.setViewportSize({ width: 375, height: 568 })
  await page.waitForFunction(() => {
    const navigation = document.querySelector('.directory-navigation [aria-label="Current folder"]')!
    return (
      navigation.querySelector('[aria-current="page"]')!.getBoundingClientRect().right <=
      navigation.getBoundingClientRect().right + 1
    )
  })
  const geometry = await top()
    .getByRole("navigation", { name: "Current folder", exact: true })
    .evaluate((element) => {
      const current = element.querySelector('[aria-current="page"]')!.getBoundingClientRect()
      const navigation = element.getBoundingClientRect()
      return { left: current.left - navigation.left, right: current.right - navigation.right }
    })
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.right).toBeLessThanOrEqual(1)
  const confirm = top().getByRole("button", { name: "Use selected folders", exact: true })
  expect(await confirm.isDisabled()).toBe(false)
  await confirm.click()
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  expect(await page.evaluate<DialogSelectDirectoryResult[]>("window.fixture.selected")).toEqual([
    { directory: ["/projects/alpha"] },
  ])
  expect(await page.getByRole("textbox", { name: "Project name" }).inputValue()).toBe("Keep this draft")
  expect(errors).toEqual([])
}, 20_000)

test("single selection keeps the current-folder action and the footer reachable in a narrow short window", async () => {
  await page.setViewportSize({ width: 375, height: 568 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open("?single")
  expect(await top().evaluate((element) => getComputedStyle(element).animationName)).toBe("none")
  await edit().click()
  await editor().fill("/projects")
  await editor().press("Enter")
  await editor().waitFor({ state: "detached" })
  const confirm = top().getByRole("button", { name: "Use this folder", exact: true })
  const box = await confirm.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  expect(box!.y + box!.height).toBeLessThanOrEqual(568)
  await confirm.click()
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  expect(await page.evaluate<DialogSelectDirectoryResult[]>("window.fixture.selected")).toEqual([
    { directory: "/projects" },
  ])
  expect(errors).toEqual([])
}, 20_000)

test("confirming the first folders returns focus to the retained add-folder control", async () => {
  await open("?fields")
  expect(await page.locator(".project-folder-empty").isDisabled()).toBe(true)
  await selectFolder("alpha")
  await selectFolder("beta")
  await top().getByRole("button", { name: "Use selected folders", exact: true }).click()
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  const add = page.getByRole("button", { name: "Add folder", exact: true })
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add folder")
  expect(await page.getByRole("textbox", { name: "Project name" }).inputValue()).toBe("Keep this draft")
  expect(await page.evaluate<DialogSelectDirectoryResult[]>("window.fixture.selected")).toEqual([
    { directory: ["/projects/alpha", "/projects/beta"] },
  ])
  await add.press("Enter")
  await top().getByRole("button", { name: "alpha", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.locator(".directory-navigation").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Add folder")
  expect(await page.locator(".project-folder-row").count()).toBe(2)
  expect(errors).toEqual([])
}, 20_000)
