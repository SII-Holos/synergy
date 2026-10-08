import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let directory: string, server: ViteDevServer, browser: Browser, page: Page
const source = path.resolve(import.meta.dir, "../../src")
interface Fixture {
  request(id: string, text?: string, image?: string): void
  owner(id: string): void
  fail(value: boolean): void
  remote(revision: number): void
  recover(): void
  facts(): {
    inputs: Array<{ messageID: string; parts: Array<{ type: string; text?: string; url?: string }> }>
    reads: number
    states: number[]
  }
}
async function fixture<T>(action: (fixture: Fixture) => T): Promise<T> {
  return page.evaluate(`(${action.toString()})(window.fixture)`)
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".render-confirmation-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "bridge.ts"),
    `
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    const [session,setSession]=createSignal("ses_test"),[generation,setGeneration]=createSignal(0)
    const state=revision=>({revision,updatedAt:revision,content:{modelContent:revision}})
    const [data,setData]=createStore({session:[{id:"ses_test"}],part:{msg_test:[{id:"prt_test",type:"tool",state:{status:"completed",metadata:{visualState:state(0)}}}]}})
    let failed=false,reads=0;const inputs=[],states=[]
    export const visual={format:"synergy.visual",version:1,id:"00000000-0000-4000-8000-000000000001",mode:"interactive",title:"Timing",layout:"normal",libraries:[],html:"<p>Timing</p>"}
    export const target={sessionID:"ses_test",messageID:"msg_test",partID:"prt_test"}
    export const fixture=window.fixture={owner:setSession,fail:value=>failed=value,
      remote:revision=>setData("part","msg_test",0,"state","metadata","visualState",state(revision)),recover:()=>setGeneration(value=>value+1),
      facts:()=>({inputs,reads,states}),observe:value=>states.push(value.revision),unavailable:()=>{}}
    const client={render:{async get(){reads++;return {data:{source:visual,state:state(9)}}}},session:{async input(input){inputs.push(input);if(failed){failed=false;throw new Error("Connection interrupted")};return {data:{accepted:true}}}}}
    export const useSDK=()=>({url:"http://fixture.test",scopeKey:"home",client})
    export const useParams=()=>({get id(){return session()}})
    export const useSync=()=>({data,get reconnectVersion(){return generation()}})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {useRenderHost} from "@ericsanchezok/synergy-ui/context/render"
    import {SessionRenderProvider} from ${JSON.stringify(`/@fs/${source}/context/render.tsx`)}
    import {fixture,visual,target} from "./bridge"
    function Probe(){const host=useRenderHost();fixture.request=(requestID,text="Adjust timing",image)=>{host.followUp(target,visual,{requestID,text,...(image?{image}:{})}).catch(()=>{})};host.observe(target,fixture.observe,fixture.unavailable);return <textarea aria-label="Composer"/>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><SessionRenderProvider><Probe/></SessionRenderProvider></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const bridge = path.join(directory, "bridge.ts")
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    logLevel: "error",
    plugins: [solid()],
    resolve: {
      alias: [
        { find: "./sdk", replacement: bridge },
        { find: "./sync", replacement: bridge },
        { find: "@solidjs/router", replacement: bridge },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "zod"],
      noDiscovery: true,
    },
    server: { hmr: false, host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../.."), directory] } },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.waitForFunction(() => !!(window as unknown as { fixture: Fixture }).fixture?.request)
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("requests require a host confirmation and cancellation preserves the composer", async () => {
  await page.getByRole("textbox", { name: "Composer" }).fill("My unsent draft")
  await fixture((f) => {
    f.request("cancel")
    f.request("cancel")
  })
  expect(await page.getByRole("dialog").count()).toBe(1)
  expect((await fixture((f) => f.facts())).inputs).toHaveLength(0)
  await page.getByRole("button", { name: "Close dialog" }).click()
  expect(await page.getByRole("textbox", { name: "Composer" }).inputValue()).toBe("My unsent draft")
  expect((await fixture((f) => f.facts())).inputs).toHaveLength(0)
})

test("confirmed retries retain one Inbox identity and include the reviewed PNG", async () => {
  await fixture((f) => {
    f.fail(true)
    f.request(
      "retry",
      "Adjust timing",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    )
  })
  await page.getByRole("textbox", { name: "Request", exact: true }).fill("Use four workers")
  expect(await page.getByRole("img", { name: "Selected visual region" }).count()).toBe(1)
  await page.getByRole("button", { name: "Send request" }).click()
  await page.getByRole("alert").filter({ hasText: "Connection interrupted" }).waitFor()
  expect(await page.getByRole("textbox", { name: "Request", exact: true }).isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Send request" }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  const facts = await fixture((f) => f.facts())
  expect(facts.inputs).toHaveLength(2)
  expect(facts.inputs[0].messageID).toBe(facts.inputs[1].messageID)
  expect(facts.inputs[0].parts[0].text).toContain("Use four workers")
  expect(facts.inputs[0].parts[1].url).toStartWith("data:image/png;base64,")
  expect(await page.getByRole("textbox", { name: "Composer" }).inputValue()).toBe("My unsent draft")
})

test("owner changes cancel confirmation and canonical updates need no per-event fetch", async () => {
  const before = await fixture((f) => f.facts())
  await fixture((f) => {
    f.remote(7)
    f.remote(8)
  })
  const updated = await fixture((f) => f.facts())
  expect(updated.states.at(-1)).toBe(8)
  expect(updated.reads).toBe(before.reads)
  await fixture((f) => f.recover())
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().states.at(-1) === 9)
  expect((await fixture((f) => f.facts())).reads).toBe(before.reads + 1)
  await fixture((f) => f.request("switch"))
  await page.getByRole("dialog").waitFor()
  await fixture((f) => f.owner("ses_other"))
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  expect((await fixture((f) => f.facts())).inputs).toHaveLength(2)
})
