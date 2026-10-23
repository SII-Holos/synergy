import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".review-data-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "contexts.ts"),
    `
    import {createSignal} from "solid-js"
    const [id,setId]=createSignal("first")
    const [summary,setSummary]=createSignal({diffRevision:"1"})
    export const turn=new URLSearchParams(location.search).has("turn")
    let latest=1
    export const reads=[]
    export const released=[]
    export const advance=()=>{latest++;setSummary({diffRevision:String(latest)})}
    export const requests={comparison:0,notes:0}
    let failing=true
    export const recover=()=>{failing=false}
    export const switchSession=()=>{failing=true;setId("second")}
    export const useParams=()=>({get id(){return id()}})
    export const useFile=()=>({workspace:{id:"workspace",generation:1,path:"/fixture"}})
    export const useSync=()=>({session:{get:()=>({summary:summary()})}})
    export const useSDK=()=>({url:"fixture",scopeKey:"scope",event:{on:()=>()=>{}},client:{
      session:{files:{
        comparison:async()=>{requests.comparison++;return {data:{revision:String(latest),recording:{status:"live"},files:Array.from({length:300},(_,i)=>({file:"file-"+i+".txt",additions:latest,deletions:0,workspace:{id:"workspace",generation:1,root:"/fixture"}}))}}},
        release:async(query)=>{released.push(query.revision)},
        diff:async(query)=>{reads.push({kind:"diff",revision:query.revision});return {data:{file:query.file,additions:Number(query.revision),deletions:0,patch:"revision "+query.revision}}},
        versions:async(query)=>{reads.push({kind:"versions",revision:query.revision});return {data:{before:{version:"before",content:"before"},after:{version:query.revision,content:"revision "+query.revision}}}},
      },diff:async(_input,{signal})=>{requests.comparison++;await Promise.resolve();signal.throwIfAborted();if(failing)throw new Error("comparison unavailable");return {data:[{file:"first.txt",additions:1,deletions:0}]}}},
      review:{state:{get:async()=>{requests.notes++;await Promise.resolve();if(failing)throw new Error("notes unavailable");return {data:{revision:1,state:{version:1,viewed:{},comments:[]}}}}}}
    }})
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {ErrorBoundary} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {useReviewData} from ${JSON.stringify(`/@fs/${appSrc}/components/workspace/review-data.ts`)}
    import {recover,switchSession,requests,turn,advance,reads,released} from "./contexts"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    function Panel(){
      const data=useReviewData({source:()=>turn?"turn":"session",messageID:()=>turn?"root-outside-window":undefined,from:()=>"HEAD",to:()=>"HEAD"})
      window.turnReview={advance,refresh:data.refresh,load:()=>data.load(data.rows()[0]),facts:()=>({requests,reads,released,count:data.rows().length,revision:data.context()?.revision})}
      return <><output data-testid="rows">{data.rows().map(row=>row.file).join(",")}</output>
        <output data-testid="notes">{data.state()?.comments.length}</output>
        <output data-testid="error">{data.comparison.error?.message} {data.notes.error?.message}</output>
        <button onClick={()=>{recover();data.refresh();data.reloadNotes()}}>Retry</button>
        <button onClick={switchSession}>Switch session</button>
        <button onClick={()=>{document.querySelector("[data-testid=counts]").textContent=JSON.stringify(requests)}}>Inspect requests</button>
        <output data-testid="counts"/>
      </>
    }
    render(()=><I18nProvider i18n={i18n}><ErrorBoundary fallback={error=><div data-testid="fatal">{String(error)}</div>}><Panel/></ErrorBoundary></I18nProvider>,document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: [
        ...["@solidjs/router", "@/context/sdk", "@/context/file", "@/context/sync"].map((find) => ({
          find,
          replacement: path.join(fixture, "contexts.ts"),
        })),
        { find: "@", replacement: appSrc },
        { find: "lru_map", replacement: Bun.resolveSync("lru_map", path.resolve(appSrc, "../../../packages/ui")) },
      ],
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "@lingui/core",
        "@lingui/solid",
        "lru_map",
        "@pierre/diffs",
      ],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("initial comparison and notes failures remain local and retry explicitly without leaking prior session data", async () => {
  await page.goto(base)
  await page.getByTestId("error").getByText("comparison unavailable notes unavailable", { exact: true }).waitFor()
  expect(await page.getByTestId("fatal").count()).toBe(0)
  await page.getByRole("button", { name: "Inspect requests" }).click()
  expect(JSON.parse((await page.getByTestId("counts").textContent()) ?? "{}")).toEqual({ comparison: 1, notes: 1 })
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByTestId("rows").getByText("first.txt", { exact: true }).waitFor()
  expect(await page.getByTestId("notes").textContent()).toBe("0")
  await page.getByRole("button", { name: "Switch session" }).click()
  await page.getByTestId("error").getByText("comparison unavailable notes unavailable", { exact: true }).waitFor()
  expect(await page.getByTestId("rows").textContent()).toBe("")
  expect(await page.getByTestId("notes").textContent()).toBe("")
  expect(await page.getByTestId("fatal").count()).toBe(0)
  expect(errors).toEqual([])
}, 30_000)

test("turn Review retains a complete immutable comparison until explicit refresh without loading offscreen contents", async () => {
  await page.goto(base + "?turn")
  await page
    .getByTestId("rows")
    .getByText(/file-299.txt/)
    .waitFor()
  const facts = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          turnReview: {
            facts(): {
              requests: { comparison: number }
              reads: Array<{ kind: string; revision: string }>
              released: string[]
              count: number
              revision: string
            }
          }
        }
      ).turnReview.facts(),
    )
  expect(await facts()).toMatchObject({ count: 300, revision: "1", reads: [] })
  await page.evaluate(() => {
    const review = (window as unknown as { turnReview: { advance(): void } }).turnReview
    for (let i = 0; i < 5; i++) review.advance()
  })
  expect((await facts()).requests.comparison).toBe(1)
  expect((await facts()).revision).toBe("1")
  await page.evaluate(() => (window as unknown as { turnReview: { load(): Promise<unknown> } }).turnReview.load())
  expect((await facts()).reads).toEqual([
    { kind: "diff", revision: "1" },
    { kind: "versions", revision: "1" },
  ])
  await page.evaluate(() => (window as unknown as { turnReview: { refresh(): void } }).turnReview.refresh())
  await page.waitForFunction(
    () =>
      (window as unknown as { turnReview: { facts(): { revision: string; reads: unknown[] } } }).turnReview.facts()
        .reads.length === 4,
  )
  expect(await facts()).toMatchObject({
    revision: "6",
    released: ["1"],
    reads: [
      { kind: "diff", revision: "1" },
      { kind: "versions", revision: "1" },
      { kind: "diff", revision: "6" },
      { kind: "versions", revision: "6" },
    ],
  })
  expect(errors).toEqual([])
}, 30_000)
