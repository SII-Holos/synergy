import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let server: ViteDevServer
let browser: Browser
let page: Page
let directory: string
let origin: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

interface BossFixtureWindow extends Window {
  fixture: {
    assignments: { sessionID: string; taskID: string; task: string }[]
    setStatus: (sessionID: string, status: "running" | "idle") => void
    release: () => void
  }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".boss-panel-"))
  const transport = path.join(directory, "transport.ts")
  await Bun.write(
    transport,
    `
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const tree = {
      sessionID:"ses_boss",title:"Fixture boss",role:"boss",status:"idle",
      children:[
        {sessionID:"ses_code",title:"Code worker",workerRole:"code",role:"worker",status:"idle",children:[]},
        {sessionID:"ses_review",title:"Review worker",role:"worker",status:"idle",children:[]},
        {sessionID:"ses_busy",title:"Busy worker",workerRole:"busy",role:"worker",status:"running",children:[
          {sessionID:"ses_nested",title:"Nested worker",workerRole:"nested",role:"worker",status:"idle",children:[]},
        ]},
      ],
    }
    const listeners = new Map()
    const fixture = window.fixture = {
      assignments:[],release:()=>{},
      setStatus(sessionID,status){
        tree.children.find(node=>node.sessionID===sessionID).status=status
        for(const callback of listeners.get("session.updated") ?? [])callback()
      },
    }
    const fetch = async request => {
      const pathname = new URL(request.url).pathname
      if(pathname==="/boss/session/ses_boss/tree")return Response.json({tree})
      if(pathname==="/boss/session/ses_boss/assign"){
        fixture.assignments.push(await request.json())
        if(new URLSearchParams(location.search).has("hold"))await new Promise(resolve=>fixture.release=resolve)
        return Response.json(true)
      }
      throw new Error("Unexpected Boss request " + pathname)
    }
    export const sdk = {
      client:createSynergyClient({baseUrl:"http://boss",fetch,throwOnError:true}),
      event:{on(type,callback){
        const handlers=listeners.get(type) ?? new Set()
        listeners.set(type,handlers)
        handlers.add(callback)
        return ()=>handlers.delete(callback)
      }},
    }
    export const useNavigateToSession = () => () => {}
    `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html style="overflow:hidden"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh;overflow:hidden"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {BossPanel} from ${JSON.stringify(`/@fs/${source}/components/boss/boss-panel.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    import {sdk} from "./transport"
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><BossPanel sdk={sdk} sessionID="ses_boss"/></DialogProvider></I18nProvider>,document.getElementById("root"))
    `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind()],
    resolve: {
      alias: [
        { find: "@/composables/use-navigate-to-session", replacement: transport },
        { find: /^@\/components\/dialog$/, replacement: path.join(source, "components/dialog/confirm-dialog.tsx") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(source, "../../.."), directory] },
    },
  })
  await server.listen()
  origin = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(query = "", colorScheme: "light" | "dark" = "light") {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(origin + query)
  await page.getByRole("button", { name: "Assign a task to an idle worker", exact: true }).click()
}

test("worker menu skips the disabled placeholder during keyboard navigation without assigning", async () => {
  await open()
  const trigger = page.getByRole("button", { name: /^Select worker…:/ })
  await trigger.press("ArrowDown")
  const code = page.getByRole("option", { name: "code (code)", exact: true })
  expect(await page.getByRole("option").allTextContents()).toEqual([
    "Select worker…",
    "code (code)",
    "Review worker (worker)",
  ])
  expect(await page.getByRole("option", { name: "Select worker…", exact: true }).getAttribute("aria-disabled")).toBe(
    "true",
  )
  await page.waitForFunction((element) => document.activeElement === element, await code.elementHandle())
  await page.keyboard.press("End")
  expect(await trigger.textContent()).toContain("Select worker…")
  await page.keyboard.press("Escape")
  await page.getByRole("listbox").waitFor({ state: "detached" })
  await page.waitForFunction((element) => document.activeElement === element, await trigger.elementHandle())
  expect(await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.assignments)).toEqual([])
  expect(errors).toEqual([])
}, 30_000)

test("worker menu stages a direct idle identity and assigns only after validated submission", async () => {
  await open("?hold")
  const trigger = page.getByRole("button", { name: /^Select worker…:/ })
  const assign = page.getByRole("button", { name: "Assign", exact: true })
  const task = page.getByPlaceholder("Task description…", { exact: true })
  expect(await assign.isDisabled()).toBe(true)
  await trigger.click()
  await page.getByRole("option", { name: "code (code)", exact: true }).click()
  expect(await assign.isDisabled()).toBe(true)
  await task.fill("   ")
  expect(await assign.isDisabled()).toBe(true)
  await task.fill("  Inspect the change  ")
  expect(await assign.isEnabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.assignments)).toEqual([])
  await assign.click()
  await page.waitForFunction(() => (window as unknown as BossFixtureWindow).fixture.assignments.length === 1)
  const [assignment] = await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.assignments)
  expect(assignment).toMatchObject({ sessionID: "ses_code", task: "Inspect the change" })
  expect(assignment?.taskID).toMatch(/^task-/)
  await task.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Assign a task to an idle worker", exact: true }).click()
  expect(await task.inputValue()).toBe("")
  await task.fill("A staged follow-up")
  expect(await assign.isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.release())
  await page.waitForFunction(
    (element) => element?.isConnected && !(element as HTMLButtonElement).disabled,
    await assign.elementHandle(),
  )
  expect(await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.assignments)).toHaveLength(1)
  expect(errors).toEqual([])
}, 30_000)

test("live idle-worker changes clear an obsolete selection without losing the staged task", async () => {
  await open("", "dark")
  const trigger = page.getByRole("button", { name: /^Select worker…:/ })
  const task = page.getByPlaceholder("Task description…", { exact: true })
  const assign = page.getByRole("button", { name: "Assign", exact: true })
  await trigger.click()
  await page.getByRole("option", { name: "code (code)", exact: true }).click()
  await task.fill("Keep this task")
  await trigger.click()
  await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.setStatus("ses_code", "running"))
  await page.getByRole("option", { name: "code (code)", exact: true }).waitFor({ state: "detached" })
  expect(await trigger.textContent()).toContain("Select worker…")
  expect(await assign.isDisabled()).toBe(true)
  expect(await task.inputValue()).toBe("Keep this task")
  await page.getByRole("option", { name: "Review worker (worker)", exact: true }).click()
  expect(await assign.isEnabled()).toBe(true)
  expect(await trigger.textContent()).toContain("Review worker (worker)")
  await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.setStatus("ses_review", "running"))
  await page
    .getByRole("button", { name: "Assign a task to an idle worker", exact: true })
    .waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as BossFixtureWindow).fixture.assignments)).toEqual([])
  expect(errors).toEqual([])
}, 30_000)
