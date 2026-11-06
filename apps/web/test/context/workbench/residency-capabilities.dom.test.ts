import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

type Fixture = {
  remove(): void
  unregister(): void
  pause(): void
  resume(): void
  features(features?: string[]): void
  generation(value: string): void
  summary(markdown?: string, revision?: number, reviewed?: number): void
  session(present: boolean, phase?: "loading" | "ready" | "error"): void
  owner(server: string, scope: string, sessionID: string): void
  route(sessionID: string): void
  openSummary(): Promise<unknown>
  facts(): {
    mounts: number
    disposed: number
    aborted: boolean[]
    active: boolean[]
    saved: number
    visible: number
    copied: string
    loads: number
  }
}
let directory: string
let fixture: BrowserFixture
let browser: Browser
let page: Page
const errors: string[] = []
const facts = () => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.facts())

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".residency-capabilities-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    import { createStore, reconcile } from "solid-js/store"
    import { createIntlFormatter } from ${JSON.stringify(path.join(source, "context/locale/formatter.ts"))}
    export const summaryMode = new URL(location.href).searchParams.has("summary")
    export const locale = new URL(location.href).searchParams.get("locale") ?? "en"
    export const [selection,setSelection]=createSignal(new URL(location.href).searchParams.has("unknown") ? undefined : {features:summaryMode?["session-long-term-memory"]:["plugin-host","note","blueprint","lattice"]})
    export const [active,setActive]=createSignal(true)
    export const [owner,setOwner]=createStore({server:"server-a",scope:"scope-a",sessionID:"session-a"})
    export const ownerKey = () => JSON.stringify([owner.server,owner.scope,owner.sessionID])
    const [selectedRoute,setSelectedRoute]=createSignal("session-a")
    const [records,setRecords]=createStore({})
    const [phase,setPhase]=createSignal("ready")
    const recordKey = id => JSON.stringify([owner.server,owner.scope,id])
    export const route = setSelectedRoute
    export function summary(markdown,revision=1,reviewed){setRecords(recordKey(owner.sessionID),reconcile({id:owner.sessionID,longTermMemory:markdown===undefined?undefined:{markdown,revision},longTermMemoryReview:reviewed===undefined?undefined:{reviewedThrough:{created:reviewed,messageID:"private-message-id"}}}))}
    summary()
    export function session(present,next="ready"){setPhase(next);if(present)summary();else setRecords(recordKey(owner.sessionID),undefined)}
    export const useSync=()=>({get ready(){return phase()!=="loading"},session:{get:id=>records[recordKey(id)],loadState:()=>({phase:phase()})}})
    export const useSDK=()=>({get url(){return owner.server},get scopeKey(){return owner.scope}})
    const surfaces = Object.fromEntries(["side","bottom"].map(name=>{
      const [tabs,setTabs]=createSignal(name==="side"?[{id:"plugin",panelId:summaryMode?"long-term-summary":location.search==="?builtin"?"notes":"fixture:panel",title:"Plugin"}]:[])
      const [selected,setSelected]=createSignal(name==="side"?"plugin":undefined)
      const [opened,setOpened]=createSignal(name==="side")
      const [size,setSize]=createSignal(name==="side"?360:200)
      const [fullscreen,setFullscreen]=createSignal(false)
      return [name,{tabs,setTabs,active:selected,setActive:setSelected,opened,open:()=>setOpened(true),close:()=>setOpened(false),size,setSize,fullscreen,setFullscreen,reveal:()=>({interacted:false}),setReveal(){}}]
    }))
    export const saved=()=>surfaces.side.tabs().length
    export const remove=()=>surfaces.side.setTabs([])
    export const useGlobalSDK=()=>({capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false}})
    export const useLayout=()=>({surface:(_,name)=>surfaces[name],isDesktop:()=>true,sidebar:{opened:()=>false,width:()=>260,occupiedWidth:()=>0}})
    export const useParams=()=>({dir:"scope-a",get id(){return selectedRoute()}})
    export const useLocation=()=>({get pathname(){return "/"+selectedRoute()}})
    export const useLocale=()=>({i18n:{_:value=>value.message},fmt:createIntlFormatter(()=>locale)})
    export const useConfirm=()=>({ask:async()=>true})
    export const useDialog=()=>({active:false})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { batch,createEffect,createSignal,onCleanup,For } from "solid-js"
    import { MetaProvider } from "@solidjs/meta"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
    import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { configureClipboard } from ${JSON.stringify(path.resolve(source, "../../../packages/ui/src/components/clipboard-core.ts"))}
    import { SessionRouteProvider } from "@/context/session-route"
    import { LongTermSummaryWorkbenchContent } from "@/components/workspace/tool-long-term-summary"
    import { messages as en } from ${JSON.stringify(path.join(source, "locales/en/messages.po"))}
    import { messages as zh } from ${JSON.stringify(path.join(source, "locales/zh-CN/messages.po"))}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(source, "index.css"))}
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { WorkbenchPanelsProvider,useWorkbenchPanels } from "@/context/workbench"
    import { WorkbenchSurface } from "@/components/workspace/workbench-surface"
    import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
    import { createPluginSurfaceLifetime } from "@/plugin/surface-lifetime"
    import { ViewActivityProvider,useViewActivity } from "@/context/view-residency"
    import { active,setActive,setSelection,saved,remove,summaryMode,locale,summary,session,owner,setOwner,ownerKey,route } from "./services"
    const requests=[],activities=[]
    let mounts=0,disposed=0,panels,loads=0,copied=""
    configureClipboard({writer:text=>{copied=text}})
    const [draft,setDraft]=createSignal("")
    function Panel(){
      mounts++
      const active=useViewActivity()
      const lifetime=createPluginSurfaceLifetime(error=>{throw error})
      requests.push(lifetime.context.signal)
      activities.push(lifetime.context.active)
      createEffect(()=>lifetime.setActive(active()))
      onCleanup(()=>{disposed++;lifetime.dispose()})
      return <input aria-label="Plugin draft" value={draft()} onInput={event=>setDraft(event.currentTarget.value)}/>
    }
    let generation="one"
    let release=()=>{}
    const builtin=location.search==="?builtin"
    const summaryLoader=async()=>{loads++;return {default:()=>{mounts++;onCleanup(()=>disposed++);return <LongTermSummaryWorkbenchContent/>}}}
    const register=()=>{release();release=registerWorkbenchPanel(summaryMode?{id:"long-term-summary",pluginId:"builtin",requiresSession:true,label:"Long-term summary",icon:"file",surface:"side",cardinality:"singleton",loader:summaryLoader}:{id:builtin?"notes":"fixture:panel",pluginId:builtin?"builtin":"fixture",retention:"pause",generation,component:Panel,label:"Plugin",icon:"file",surface:"side",cardinality:"multi"})}
    register()
    window.fixture={
      remove,
      unregister:()=>release(),
      pause(){batch(()=>{setActive(false);release()})},
      resume(){batch(()=>{register();setActive(true)})},
      features:features=>setSelection(features?{features}:undefined),
      generation(value){generation=value;register()},
      summary,session,route,
      owner(server,scope,sessionID){batch(()=>{setOwner({server,scope,sessionID})})},
      openSummary:()=>panels.openPanel("long-term-summary"),
      facts:()=>({mounts,disposed,aborted:requests.map(signal=>signal.aborted),active:activities.map(read=>read()),saved:saved(),visible:panels.surface("side").tabs().length,copied,loads})
    }
    function Content(){panels=useWorkbenchPanels();return <div style="width:100%;height:600px;display:flex"><WorkbenchSurface surface="side"/></div>}
    const i18n=setupI18n({locale,messages:{en,"zh-CN":zh}})
    render(()=><MetaProvider><Font/><ThemeProvider><ResourceOpenProvider value={{open:async()=>({status:"opened"})}}><I18nProvider i18n={i18n}><MarkedProvider><ViewActivityProvider active={active}><For each={[ownerKey()]}>{()=> <SessionRouteProvider params={{dir:owner.scope,id:owner.sessionID}}><WorkbenchPanelsProvider><Content/></WorkbenchPanelsProvider></SessionRouteProvider>}</For></ViewActivityProvider></MarkedProvider></I18nProvider></ResourceOpenProvider></ThemeProvider></MetaProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      ...[
        "@solidjs/router",
        "@/context/sdk",
        "@/context/sync",
        "@/context/global-sdk",
        "@/context/layout",
        "@/context/locale",
        "@/components/dialog/confirm-dialog",
        "@ericsanchezok/synergy-ui/context/dialog",
        "../layout",
      ].map((find) => ({ find: new RegExp(`^${find.replaceAll(".", "\\.")}$`), replacement: services })),
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("long-term summary keeps metadata internal and preserves reading until View latest", async () => {
  await page.goto(`${fixture.url}?summary`)
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  const markdown =
    "# Canonical summary\n\n**Saved decision**\n\n" +
    Array.from(
      { length: 260 },
      (_, index) =>
        `Reading paragraph ${index}: Keep the full saved Markdown, including every detailed decision and its original wording.`,
    ).join("\n\n") +
    "\n\n```ts\nconst saved = true\n```\n\nFinal saved paragraph.\n"
  await page.evaluate(
    (markdown) => (window as unknown as { fixture: Fixture }).fixture.summary(markdown, 4, 1700000000000),
    markdown,
  )
  await page.getByRole("heading", { name: "Canonical summary", exact: true }).waitFor()
  await page.getByText("Final saved paragraph.", { exact: true }).waitFor()
  expect(await page.locator('[data-component="markdown"] strong').textContent()).toBe("Saved decision")
  await page.getByRole("button", { name: "Copy long-term summary", exact: true }).click()
  expect((await facts()).copied).toBe(markdown)
  const body = page.locator('[data-slot="long-term-summary-body"]')
  const viewportNode = await body.elementHandle()
  const paragraph = page.getByText(
    "Reading paragraph 70: Keep the full saved Markdown, including every detailed decision and its original wording.",
    { exact: true },
  )
  await paragraph.scrollIntoViewIfNeeded()
  const original = await paragraph.elementHandle()
  await paragraph.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const reading = await body.evaluate((element) => ({
    scroll: element.scrollTop,
    selection: window.getSelection()!.toString(),
  }))
  const header = page.locator('[data-component="long-term-summary"] header')
  expect(await header.getByText("Body revision 4", { exact: true }).count()).toBe(0)
  expect(await header.getByText(/^Reviewed through messages from/).count()).toBe(0)
  await page.evaluate(
    (markdown) => (window as unknown as { fixture: Fixture }).fixture.summary(markdown, 4, 1700003600000),
    markdown,
  )
  expect(await header.getByText(/^Reviewed through messages from/).count()).toBe(0)
  expect(await paragraph.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(
    await body.evaluate((element) => ({ scroll: element.scrollTop, selection: window.getSelection()!.toString() })),
  ).toEqual(reading)
  expect(await page.getByRole("button", { name: "View latest", exact: true }).count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.summary(
      "# New canonical summary\n\nNew saved body.",
      5,
      1700007200000,
    ),
  )
  const latest = page.getByRole("button", { name: "View latest", exact: true })
  await latest.waitFor()
  expect(await header.getByText(/^Reviewed through messages from/).count()).toBe(0)
  expect(await header.getByText("Body revision 4", { exact: true }).count()).toBe(0)
  expect(await paragraph.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(
    await body.evaluate((element) => ({ scroll: element.scrollTop, selection: window.getSelection()!.toString() })),
  ).toEqual(reading)
  await page.getByRole("button", { name: "Copy long-term summary", exact: true }).click()
  expect((await facts()).copied).toBe(markdown)
  await latest.focus()
  await latest.press("Enter")
  await page.getByRole("heading", { name: "New canonical summary", exact: true }).waitFor()
  expect(await header.getByText("Body revision 5", { exact: true }).count()).toBe(0)
  expect(await header.getByText(/^Reviewed through messages from/).count()).toBe(0)
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0)
  expect(await body.evaluate((element, previous) => element === previous, viewportNode)).toBe(true)
  await page.getByRole("button", { name: "Copy long-term summary", exact: true }).click()
  expect((await facts()).copied).toBe("# New canonical summary\n\nNew saved body.")
  expect((await facts()).mounts).toBe(1)
  expect(errors).toEqual([])
}, 30000)

test("long-term summary distinguishes loading, failed and missing Session and clears deleted or rolled-back bodies", async () => {
  await page.goto(`${fixture.url}?summary`)
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.session(false, "loading"))
  await page.getByText("Loading session…", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.session(false, "error"))
  await page.getByText("Unable to load session.", { exact: true }).waitFor()
  expect(await page.getByText("Session not found.", { exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.session(false))
  await page.getByText("Session not found.", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.session(true))
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  expect(await page.getByText("Reviewed message coverage is unknown.", { exact: true }).count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.summary("Future body", 8, 1700000000000),
  )
  await page.getByText("Future body", { exact: true }).waitFor()
  await page.getByText("Future body", { exact: true }).evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.summary("Rollback body", 3, 1690000000000),
  )
  await page.getByText("Rollback body", { exact: true }).waitFor()
  expect(await page.getByText("Future body", { exact: true }).count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.summary("Pending body", 9, 1710000000000),
  )
  await page.getByRole("button", { name: "View latest", exact: true }).waitFor()
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.summary(undefined, undefined, 1710000000000),
  )
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  expect(await page.getByText("Rollback body", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "View latest", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Copy long-term summary", exact: true }).isDisabled()).toBe(true)
  expect(await page.getByText(/^Reviewed through messages from/).count()).toBe(0)
  expect(await page.getByText("private-message-id", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("long-term summary stays Session-route bound and isolates Session, Scope and server owners", async () => {
  await page.goto(`${fixture.url}?summary`)
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.summary("Original owner body", 1))
  await page.getByText("Original owner body", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.route("selected-execution-child"))
  expect(await page.getByText("Original owner body", { exact: true }).count()).toBe(1)
  for (const [server, scope, sessionID] of [
    ["server-a", "scope-a", "session-b"],
    ["server-a", "scope-b", "session-b"],
    ["server-b", "scope-b", "session-b"],
  ]) {
    await page.evaluate(
      ([server, scope, sessionID]) =>
        (window as unknown as { fixture: Fixture }).fixture.owner(server, scope, sessionID),
      [server, scope, sessionID],
    )
    await page.getByText("Session not found.", { exact: true }).waitFor()
    expect(await page.getByText("Original owner body", { exact: true }).count()).toBe(0)
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.summary("Current owner body", 1))
    await page.getByText("Current owner body", { exact: true }).waitFor()
  }
  expect(errors).toEqual([])
})

test("long-term summary gates restored tabs and deep opens, retains unknown capability reading and restores after reinstall", async () => {
  await page.goto(`${fixture.url}?summary&unknown`)
  await page.waitForFunction(() => !!(window as unknown as { fixture: Fixture }).fixture)
  expect((await facts()).loads).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.openSummary())
  expect((await facts()).saved).toBe(1)
  expect((await facts()).visible).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(["workbench"]))
  expect((await facts()).loads).toBe(0)
  await page.evaluate(() => {
    const current = (window as unknown as { fixture: Fixture }).fixture
    current.summary("Retained summary", 1)
    current.features(["session-long-term-memory"])
  })
  await page.getByText("Retained summary", { exact: true }).waitFor()
  await page.evaluate(async () => {
    const current = (window as unknown as { fixture: Fixture }).fixture
    await current.openSummary()
    await current.openSummary()
  })
  expect((await facts()).saved).toBe(1)
  const original = await page.getByText("Retained summary", { exact: true }).elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(undefined))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await original!.isVisible()).toBe(false)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(["session-long-term-memory"]))
  expect(
    await page
      .getByText("Retained summary", { exact: true })
      .evaluate((element, previous) => element === previous, original),
  ).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.pause())
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.summary("New hidden body", 2))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resume())
  await page.getByRole("button", { name: "View latest", exact: true }).waitFor()
  expect(await page.getByText("Retained summary", { exact: true }).count()).toBe(1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  await page.evaluate(() => {
    const current = (window as unknown as { fixture: Fixture }).fixture
    current.summary()
    current.features(["session-long-term-memory"])
  })
  await page.getByText("No long-term summary yet.", { exact: true }).waitFor()
  expect(await page.getByText("Retained summary", { exact: true }).count()).toBe(0)
  expect(await page.getByText("New hidden body", { exact: true }).count()).toBe(0)
  expect((await facts()).saved).toBe(1)
  expect(errors).toEqual([])
})

test("long-term summary localizes chrome on Chinese cold start while preserving saved Markdown verbatim", async () => {
  await page.goto(`${fixture.url}?summary&locale=zh-CN`)
  await page.getByRole("heading", { name: "会话长期摘要", exact: true }).waitFor()
  await page.getByText("暂无长期摘要。", { exact: true }).waitFor()
  const markdown = "# Saved wording\n\nVerbatim LLM summary with **original emphasis**."
  await page.evaluate(
    (markdown) => (window as unknown as { fixture: Fixture }).fixture.summary(markdown, 2, 1700000000000),
    markdown,
  )
  await page.getByRole("heading", { name: "Saved wording", exact: true }).waitFor()
  const header = page.locator('[data-component="long-term-summary"] header')
  expect(await header.getByText("正文修订 2", { exact: true }).count()).toBe(0)
  expect(await header.getByText(/^已审阅至/).count()).toBe(0)
  await page.getByRole("button", { name: "复制长期摘要", exact: true }).click()
  expect((await facts()).copied).toBe(markdown)
  expect(errors).toEqual([])
})

test("inactive Scope registration changes preserve the paused plugin instance and lifetime", async () => {
  await page.goto(fixture.url)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Retained draft")
  const original = await input.elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.pause())
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 0, aborted: [false], active: [false], saved: 1 })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resume())
  expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(await input.inputValue()).toBe("Retained draft")
  expect(await facts()).toMatchObject({ mounts: 1, aborted: [false], active: [true] })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.generation("two"))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  expect(await facts()).toMatchObject({ mounts: 2, disposed: 1, aborted: [true, false] })
  expect(errors).toEqual([])
})

for (const [state, features] of [
  ["unknown", undefined],
  ["missing", []],
  ["replaced", ["plugin-host"]],
] as Array<[string, string[] | undefined]>)
  test(`a ${state} owner disposes paused plugin work while retaining stored drafts`, async () => {
    await page.goto(fixture.url)
    const input = page.getByRole("textbox", { name: "Plugin draft" })
    await input.fill("Preserved through absence")
    const original = await input.elementHandle()
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.pause())
    await page.evaluate((features) => (window as unknown as { fixture: Fixture }).fixture.features(features), features)
    expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
    expect(await facts()).toMatchObject({ mounts: 1, disposed: 1, aborted: [true], saved: 1, visible: 0 })
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: Fixture }).fixture
      fixture.features(["plugin-host"])
      fixture.resume()
    })
    await input.waitFor()
    expect(await input.inputValue()).toBe("Preserved through absence")
    expect(await facts()).toMatchObject({ mounts: 2, aborted: [true, false], saved: 1, visible: 1 })
    expect(errors).toEqual([])
  })

test("capability loss removes an active plugin even before its registry entry is released", async () => {
  await page.goto(fixture.url)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Active draft")
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 1, aborted: [true], saved: 1, visible: 0 })
  expect(await input.count()).toBe(0)
  expect(errors).toEqual([])
})

test("capability revalidation pauses a built-in panel without replacing its draft or selection", async () => {
  await page.goto(`${fixture.url}?builtin`)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Retained native draft")
  await input.evaluate((element) => (element as HTMLInputElement).setSelectionRange(3, 8))
  const original = await input.elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(undefined))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 0, active: [false], visible: 0, saved: 1 })
  expect(await original!.isVisible()).toBe(false)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(["note"]))
  expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(await input.inputValue()).toBe("Retained native draft")
  expect(
    await input.evaluate((element) => [
      (element as HTMLInputElement).selectionStart,
      (element as HTMLInputElement).selectionEnd,
    ]),
  ).toEqual([3, 8])
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 0, active: [true], visible: 1 })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  expect(await facts()).toMatchObject({ disposed: 1, visible: 0, saved: 1 })
  expect(errors).toEqual([])
})

test("closing a saved native tab during capability revalidation releases its instance permanently", async () => {
  await page.goto(`${fixture.url}?builtin`)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.waitFor()
  const original = await input.elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(undefined))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.remove())
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(["note"]))
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 1, aborted: [true], saved: 0, visible: 0 })
  expect(await input.count()).toBe(0)
  expect(errors).toEqual([])
})

test("built-in revalidation retains its paused view until registration catches up", async () => {
  await page.goto(`${fixture.url}?builtin`)
  const input = page.getByRole("textbox", { name: "Plugin draft" })
  await input.fill("Draft during registry recovery")
  const original = await input.elementHandle()
  await page.evaluate(() => {
    const fixture = (window as unknown as { fixture: Fixture }).fixture
    fixture.features(undefined)
    fixture.unregister()
  })
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(["note"]))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await input.isVisible()).toBe(false)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.generation("one"))
  expect(await input.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(await input.inputValue()).toBe("Draft during registry recovery")
  expect(await facts()).toMatchObject({ mounts: 1, disposed: 0, active: [true] })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
  expect(errors).toEqual([])
})
