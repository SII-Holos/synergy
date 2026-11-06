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
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".session-transfer-"))
  const contexts = path.join(directory, "contexts.ts")
  await Bun.write(
    contexts,
    `
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const migrationID="90b48d40-2938-4ebc-9f79-cf206e94532a",sourceID="351174e5-d914-41f9-bd6b-cc2f964c8143",targetID="b80f7082-4bc5-4367-9395-7e8a4b5119da"
    const receipt={migrationID,sessionID:"ses_fixture",sourceID,targetID,digest:"a".repeat(64),phase:"prepared"}
    const params=new URLSearchParams(location.search)
    const h=window.fixture={calls:[],phase:params.get("phase"),fail:true,active:"",route:"",releaseConnections:()=>{},releasePrepare:()=>{}}
    const transport=async request=>{
      const url=new URL(request.url), body=request.method==="POST"&&request.headers.get("content-type")?.includes("json") ? await request.json():undefined
      h.calls.push({path:url.pathname,host:url.hostname,body})
      if(url.pathname.endsWith("/cancellations"))return Response.json([])
       if(url.pathname.endsWith("/host"))return Response.json({id:params.has("missing") ? "unknown-target" : targetID})
      if(url.pathname==="/session-transfer/ses_fixture")return Response.json(h.phase ? {...receipt,phase:h.phase}:null)
       if(url.pathname.endsWith("/prepare")){if(params.has("busy"))await new Promise(resolve=>h.releasePrepare=resolve);h.phase="prepared";return Response.json({...receipt,phase:h.phase})}
      if(url.pathname.endsWith("/archive"))return new Response("fixture")
      if(url.pathname.endsWith("/stage")){if(h.fail)return Response.json({data:{message:"Target is offline"}},{status:503});return Response.json(receipt)}
      if(url.pathname.endsWith("/commit")){h.phase="committed";return Response.json({...receipt,secret:"b".repeat(64)})}
      if(url.pathname.endsWith("/activate"))return Response.json({...receipt,phase:"activated"})
      if(url.pathname.endsWith("/complete")){h.phase="completed";return Response.json({...receipt,phase:h.phase})}
      if(url.pathname.includes("/destination/")&&!url.pathname.endsWith("/discard"))return Response.json(receipt)
      if(url.pathname.endsWith("/cancel")){h.phase="cancelled";return Response.json({migrationID,sessionID:receipt.sessionID,sourceID,targetID,secret:"c".repeat(64)})}
      if(url.pathname.endsWith("/discard"))return Response.json(true)
      throw new Error("Unexpected transfer request "+url.pathname)
    }
    export const useGlobalSDK=()=>({client:createSynergyClient({baseUrl:"http://source",fetch:transport,throwOnError:true})})
    export const usePlatform=()=>({fetch:transport})
    export const useServer=()=>({url:"http://source",connections:params.has("empty") ? ["http://source"] : ["http://source","http://target"],displayName:url=>url==="http://target" ? "Target workstation" : url,refreshConnections:async()=>{if(params.has("loading"))await new Promise(resolve=>h.releaseConnections=resolve)},setActive:url=>h.active=url})
    export const serverDisplayName=url=>url
    export const useNavigate=()=>url=>h.route=url
  `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html style="overflow:hidden"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DialogSessionTransfer} from ${JSON.stringify(`/@fs/${source}/components/dialog/dialog-session-transfer.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=><DialogSessionTransfer sessionID="ses_fixture" scopeID="home"/>)}>Open transfer</button>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [
      {
        name: "session-transfer-context",
        enforce: "pre",
        resolveId(id, importer) {
          if (
            importer?.includes("/dialog-session-transfer.tsx") &&
            (["@/context/global-sdk", "@/context/platform", "@/context/server", "@solidjs/router"].includes(id) ||
              /\/context\/(global-sdk|platform|server)(\.tsx)?$/.test(id))
          )
            return contexts
        },
      },
      solid(),
      tailwind(),
    ],
    resolve: { alias: { "@": source } },
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

interface TransferFixtureWindow extends Window {
  fixture: {
    calls: { path: string; host: string; body?: { secret: string } }[]
    releaseConnections: () => void
    releasePrepare: () => void
  }
}

async function open(query = "") {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(origin + (query ? `?${query}` : ""))
  await page.locator("#open").click()
  try {
    await page.getByRole("dialog").waitFor({ timeout: 5000 })
  } catch (error) {
    console.log(errors, await page.locator("body").innerText())
    throw error
  }
}

test("precommit failure shows the error and cancels using a destination proof", async () => {
  await open()
  const destination = page.getByRole("button", { name: /^Destination device:/ })
  await destination.click()
  await page.getByRole("option", { name: "Target workstation", exact: true }).click()
  expect(
    await page.evaluate(() =>
      (window as unknown as TransferFixtureWindow).fixture.calls.some((call) => call.path.endsWith("/prepare")),
    ),
  ).toBe(false)
  await page.getByRole("button", { name: "Move task", exact: true }).click()
  await page.getByRole("alert").getByText("Target is offline").waitFor()
  expect(await destination.isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Cancel transfer" }).isEnabled()).toBe(true)
  await page.getByRole("button", { name: "Cancel transfer" }).click()
  await page.getByRole("button", { name: "Move task", exact: true }).waitFor()
  const proof = await page.evaluate(
    () =>
      (window as unknown as { fixture: { calls: { path: string; body?: { secret: string } }[] } }).fixture.calls.find(
        (call) => call.path.endsWith("/discard"),
      )?.body?.secret,
  )
  expect(proof).toBe("c".repeat(64))
  expect(await destination.isEnabled()).toBe(true)
  await destination.click()
  await page.getByRole("option", { name: "Choose a device", exact: true }).click()
  expect(await destination.textContent()).toContain("Choose a device")
  expect(await page.getByRole("button", { name: "Move task", exact: true }).isDisabled()).toBe(true)
  expect(errors).toEqual([])
}, 15_000)

test("committed retry keeps the destination locked and opens the paused task without execution", async () => {
  await open("phase=committed")
  await page.getByRole("button", { name: "Destination device: Target workstation", exact: true }).waitFor()
  expect(await page.locator("#session-transfer-destination").isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Cancel transfer" }).count()).toBe(0)
  await page.getByRole("button", { name: "Retry transfer" }).click()
  await page.getByRole("button", { name: "Open on destination" }).waitFor()
  await page.getByRole("button", { name: "Open on destination" }).click()
  const state = await page.evaluate(
    () => (window as unknown as { fixture: { active: string; route: string; calls: { path: string }[] } }).fixture,
  )
  expect(state.active).toBe("http://target")
  expect(state.route).toBe("/aG9tZQ/session/ses_fixture")
  expect(state.calls.some((call) => /archive|stage|continue|prompt/.test(call.path))).toBe(false)
  expect(errors).toEqual([])
}, 15_000)

test("destination loading and in-flight transfer stay disabled without implicit selection", async () => {
  await open("loading&busy")
  const destination = page.getByRole("button", { name: /^Destination device:/ })
  await destination.waitFor()
  expect(await destination.textContent()).toContain("Choose a device")
  expect(await destination.isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Move task", exact: true }).isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as TransferFixtureWindow).fixture.releaseConnections())
  await page.waitForFunction(
    () => !(document.querySelector("#session-transfer-destination") as HTMLButtonElement).disabled,
  )
  await destination.press("ArrowDown")
  const placeholder = page.getByRole("option", { name: "Choose a device", exact: true })
  await page.waitForFunction((element) => document.activeElement === element, await placeholder.elementHandle())
  await page.keyboard.press("ArrowDown")
  expect(await page.getByRole("button", { name: "Move task", exact: true }).isDisabled()).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByRole("listbox").waitFor({ state: "detached" })
  await page.waitForFunction((element) => document.activeElement === element, await destination.elementHandle())
  expect(await page.getByRole("dialog", { name: "Move to another device", exact: true }).isVisible()).toBe(true)
  await destination.press("Space")
  await page.getByRole("option", { name: "Target workstation", exact: true }).click()
  await page.getByRole("button", { name: "Move task", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as TransferFixtureWindow).fixture.calls.some((call) => call.path.endsWith("/prepare")),
  )
  expect(await destination.isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as TransferFixtureWindow).fixture.releasePrepare())
  await page.getByRole("alert").getByText("Target is offline").waitFor()
  expect(await destination.isDisabled()).toBe(true)
  const stage = await page.evaluate(() =>
    (window as unknown as TransferFixtureWindow).fixture.calls.find((call) => call.path.endsWith("/stage")),
  )
  expect(stage?.host).toBe("target")
  expect(errors).toEqual([])
}, 15_000)

test("no connected destination keeps the empty choice and move action unavailable", async () => {
  await open("empty")
  const destination = page.getByRole("button", { name: "Destination device: Choose a device", exact: true })
  await destination.click()
  expect(await page.getByRole("option").allTextContents()).toEqual(["Choose a device"])
  expect(await page.getByText("Add another device in the server selector first.", { exact: true }).isVisible()).toBe(
    true,
  )
  expect(await page.getByRole("button", { name: "Move task", exact: true }).isDisabled()).toBe(true)
  expect(errors).toEqual([])
}, 15_000)

test("an unmatched locked destination never falls back to the first connected device", async () => {
  await open("phase=committed&missing")
  const destination = page.getByRole("button", { name: "Destination device: Choose a device", exact: true })
  await page.getByText("The source is locked. Retry to finish on the selected destination.", { exact: true }).waitFor()
  expect(await destination.isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Retry transfer", exact: true }).isDisabled()).toBe(true)
  expect(
    await page.evaluate(() =>
      (window as unknown as TransferFixtureWindow).fixture.calls.some((call) => call.path.endsWith("/prepare")),
    ),
  ).toBe(false)
  expect(errors).toEqual([])
}, 15_000)
