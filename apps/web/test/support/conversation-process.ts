import { afterAll, beforeAll, beforeEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "./browser-fixture"
import type { VListHandle } from "virtua/solid"

type Fixture = {
  append(id: string, source?: "live" | "replay"): void
  remount(): void
  reasoning(text: string, partID?: string): void

  fragments(count: number): void
  toolCase(
    tool: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
    status?: "completed" | "error",
  ): void
  prepare(): void
  respond(): void
  phase(value?: {
    phase: "waiting_model" | "running_tools" | "preparing_files" | "stopping"
    startedAt: number
    rootID?: string
    tool?: { id?: string; count: number }
  }): void
  connected(value: boolean): void
  approval(value: boolean): void
  stream(): void
  terminal(): void
  complete(): void
  grow(count: number): void
  restoreProcess(count: number): void
  backfill(count: number): void
  hydrateBefore(count: number): void
  growReadingParagraph(id: string, count: number): void
  growToolEvidence(id: string): void
  latest(): void
  prependTurns(count: number): void
  prepend(count: number): void
  delivery(): void
  manualCompaction(): void
  compaction(state: "running" | "committed" | "failed"): void
  mode(value: "balanced" | "full" | "minimal"): void
  locate(messageID: string, partID?: string): Promise<boolean>
  reading(value: boolean): void
  retained(): number
  summaryReads(): number
  contentRecover(id: string): void
  contentPending(id: string): void
  contentFinish(id: string): void
  contentReads(id: string): number
  contentAborts(id: string): number
  contentReconnect(): void
  contentPageFinish(): void
  contentStale(): void
  contentPageLoads(): number
}
declare global {
  interface Window {
    __conversationProcess: Fixture
    answerNode?: Element | null
    __processSelection?: unknown
    __activityTitle?: Element | null
    __activityFacts?: Element | null

    __resizeErrors: string[]
    __conversationResizeList?: VListHandle
  }
}
let server: BrowserFixture, directory: string
export let browser: Browser, page: Page, url: string
export const errors: string[] = []
const app = path.resolve(import.meta.dir, "../..")
const require = createRequire(import.meta.url)
const virtualizer = path.join(path.dirname(require.resolve("virtua/package.json")), "lib/solid")
export const observeResizeErrors = (target: Page) =>
  target.addInitScript(() => {
    window.__resizeErrors = []
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver")) window.__resizeErrors.push(event.message)
    })
  })
export const fixtureServer = (entry: "index.mjs" | "index.jsx") =>
  createBrowserFixture({
    root: directory,
    entries: ["index.html", "resize.html"],
    aliases: [
      { find: /^virtua\/solid$/, replacement: path.join(directory, `virtualizer-${entry}.ts`) },
      { find: "@/context/execution", replacement: path.join(directory, "execution.ts") },
    ],
  })
export const frames = (target = page) =>
  target.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
async function freshPage() {
  await page?.close()
  page = await browser.newPage()
  await observeResizeErrors(page)
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => errors.push(error.message))
}
export const contentPage = async (scenario: string) => {
  await freshPage()
  await page.goto(`${url}?content=${scenario}`)
}
beforeEach(freshPage)
beforeAll(async () => {
  directory = await mkdtemp(path.join(app, "node_modules/.conversation-process-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><style>body{font:16px/24px system-ui}button{font:inherit}[data-component="session-turn"]{height:auto}[data-slot="session-turn-content"]{height:auto!important}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import ${JSON.stringify(`/@fs/${app}/test/fixtures/conversation/process.tsx`)}`,
  )
  await Bun.write(
    path.join(directory, "execution.ts"),
    "export const useExecution=()=>({available:()=>true,round:()=>undefined,open:()=>{}})",
  )
  await Bun.write(
    path.join(directory, "resize.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/resize.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "resize.tsx"),
    `import {createSignal} from "solid-js"
    import {render} from "solid-js/web"
    import {VList} from "virtua/solid"
    const [hidden,setHidden]=createSignal(false)
    render(()=><><button onClick={()=>setHidden(!hidden())}>Toggle list</button>
      <div style={{height:"288px",width:"320px",display:hidden()?"none":"block"}}>
        <VList style={new URL(location.href).searchParams.has("fixed")?{position:"fixed",height:"288px",width:"320px"}:undefined} ref={value=>window.__conversationResizeList=value} data={Array.from({length:100},(_,i)=>i)} itemSize={48} overscan={2} aria-label="Measured list">
          {item=><button style={{height:"48px",width:"100%",display:"block"}}>Item {item}</button>}
        </VList>
      </div></>,document.getElementById("root"))`,
  )
  for (const entry of ["index.mjs", "index.jsx"] as const)
    await Bun.write(
      path.join(directory, `virtualizer-${entry}.ts`),
      `export * from ${JSON.stringify(path.join(virtualizer, entry))}`,
    )
  server = await fixtureServer("index.mjs")
  url = server.url
  browser = await chromium.launch({ headless: true })
}, 90000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 30000)
