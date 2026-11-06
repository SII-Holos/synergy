import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { environmentCopy } from "../../../src/components/dialog/environment-dialog-copy"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".environment-dialog-"))
  const stubs = path.join(fixture, "stubs.tsx")
  await Bun.write(
    stubs,
    `
    const row=(id,provider,state="idle")=>({id,scopeID:"scope",provider,state,generation:1,ownership:"managed",spec:{},createdAt:1,updatedAt:1,lastUsedAt:1,idleTimeoutMs:60000})
    const rows=[row("env_native","native","ready"),row("env_remote","docker","unavailable")]
    const listeners=new Set()
    const h=window.fixture={requests:[],selection:[],rows,fail:false,current:"env_native",profileRequests:[],activity:0,
      emit(item){listeners.forEach(fn=>fn({properties:item}))}}
    export const useSync=()=>({session:{get:()=>({environmentID:h.current})}})
    export const useSDK=()=>({scopeID:"scope",client:{environment:{
      async profiles(){return {data:{defaultEnvironment:"native",environments:[{name:"worker",provider:"docker",reuse:"session"}],stores:[]}}},
      async list(){return {data:structuredClone(rows)}},
      async create(input){h.profileRequests.push(input);const item=row("env_new","docker");if(h.fail)throw Error("Try again");rows.push(item);return {data:item}},
      async activity(input){h.activity++;return {data:{environment:structuredClone(rows.find(r=>r.id===input.environmentID)),uses:[],files:[],executions:input.environmentID==="env_remote"?[{id:"op_saved",state:"unsaved",target:{environmentID:input.environmentID,allocationID:"one",generation:1}}]:[]}}},
      async recoverExecution(input){h.requests.push({kind:"recover",...input});return {data:{}}},
      async reconcile(input){h.requests.push({kind:"reconcile",...input});return {data:rows.find(r=>r.id===input.environmentID)}},
      async release(input){h.requests.push({kind:"release",...input});return {data:rows.find(r=>r.id===input.environmentID)}},
      async cancelExecution(input){h.requests.push({kind:"cancel",...input});return {data:{}}}},
      session:{async get(){return {data:{environmentID:h.current}}},async setEnvironment(input){h.requests.push({kind:"select",...input});if(h.fail)throw Error("Session changed");return {data:{}}}}},
      event:{on(type,fn){listeners.add(fn);return()=>listeners.delete(fn)}}})
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
    import {DialogEnvironment} from ${JSON.stringify(`/@fs/${appSrc}/components/dialog/dialog-environment.tsx`)}
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=><DialogEnvironment sessionID={location.search ? undefined : "session"} onSelect={value=>window.fixture.selection.push(value)}/>)}>Open</button>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      {
        name: "environment-fixture",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            importer?.endsWith("/dialog-environment.tsx") &&
            (["@/context/sdk", "@/context/sync"].includes(source) || /\/context\/(sdk|sync)(\.tsx)?$/.test(source))
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
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(appSrc, "../../.."), fixture] },
    },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(4000)
  page.setDefaultNavigationTimeout(15_000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})
async function open(draft = false) {
  errors.length = 0
  await page.goto(base + (draft ? "?draft" : ""))
  await page.locator("#open").click()
  await page.getByRole("button", { name: "worker", exact: true }).waitFor()
}
test("selection is conditional, failure retains the form, and opening allocates no compute", async () => {
  await open()
  expect(await page.evaluate(() => (window as any).fixture.profileRequests)).toEqual([])
  await page.getByRole("button", { name: environmentCopy.none.message, exact: true }).click()
  await page.evaluate(() => {
    ;(window as any).fixture.fail = true
    ;(window as any).fixture.current = "env_remote"
  })
  await page.getByRole("button", { name: environmentCopy.choose.message, exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate(() => (window as any).fixture.requests.at(-1))).toMatchObject({
    sessionEnvironmentSelection: { environmentID: null, expectedEnvironmentID: "env_native" },
  })
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.evaluate(() => {
    ;(window as any).fixture.fail = false
  })
  await page.getByRole("button", { name: environmentCopy.reload.message, exact: true }).click()
  await page.getByRole("button", { name: environmentCopy.choose.message, exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as any).fixture.requests.at(-1))).toMatchObject({
    sessionEnvironmentSelection: { environmentID: null, expectedEnvironmentID: "env_remote" },
  })
  expect(errors).toEqual([])
}, 20_000)
test("profile retry keeps its request identity and new-session selection is a draft", async () => {
  await open(true)
  await page.evaluate(() => {
    ;(window as any).fixture.fail = true
  })
  await page.getByRole("button", { name: "worker", exact: true }).click()
  await page.getByRole("alert").waitFor()
  await page.evaluate(() => {
    ;(window as any).fixture.fail = false
  })
  await page.getByRole("button", { name: "worker", exact: true }).click()
  await page.getByRole("button", { name: environmentCopy.choose.message, exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  const requests = await page.evaluate(() => (window as any).fixture.profileRequests)
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual(requests[1])
  expect(await page.evaluate(() => (window as any).fixture.selection)).toEqual(["env_new"])
  expect(await page.evaluate(() => (window as any).fixture.requests)).toEqual([])
  expect(errors).toEqual([])
}, 20_000)
test("recovery addresses the existing operation without submitting a command", async () => {
  await open()
  await page.getByRole("button", { name: /docker.*remote/ }).click()
  await page.getByRole("button", { name: environmentCopy.recover.message, exact: true }).click()
  expect(await page.evaluate(() => (window as any).fixture.requests.at(-1))).toMatchObject({
    kind: "recover",
    environmentID: "env_remote",
    operationID: "op_saved",
  })
  expect(await page.evaluate(() => (window as any).fixture.profileRequests)).toEqual([])
  expect(errors).toEqual([])
}, 20_000)
