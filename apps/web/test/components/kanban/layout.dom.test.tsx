import { renderedTextContrast } from "../../testing/rendered-text-contrast"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(30000)
let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".kanban-layout-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import {useLingui} from "@lingui/solid"
    export function useLocale() { const {i18n}=useLingui(); return {i18n:i18n(),controller:{activeLocale:()=>"en"}} }
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,For,Show} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {Markdown} from "@ericsanchezok/synergy-ui/markdown"
    import {MarkedProvider} from "@ericsanchezok/synergy-ui/context/marked"
    import {AppPanel} from "/@fs/${source}/components/app-panel.tsx"
    import {KanbanReorderMenu} from "/@fs/${source}/components/kanban/pane/reorder-menu.tsx"
    import {FlipPanes} from "/@fs/${source}/components/kanban/flip.tsx"
    import {KanbanPaneComposer} from "/@fs/${source}/components/kanban/pane/composer.tsx"
    import {KanbanGrid} from "/@fs/${source}/components/kanban/layout/grid.tsx"
    import {KanbanFocus} from "/@fs/${source}/components/kanban/layout/focus.tsx"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${source}/index.css"
    import "/@fs/${source}/components/kanban/kanban.css"
    const panes=Array.from({length:6},(_,index)=>({key:"pane-"+index,kind:"unavailable",scopeKey:"home",sessionID:String(index)}))
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    const pane=(current,variant,onActivate)=>{return <div class="kanban-pane" data-kind={current().kind} data-compact={variant==="rail" || undefined}><div class="kanban-pane-head" data-status="completed"><div class="kanban-pane-heading"><span class="fixture-title kanban-pane-title-text">{current().entry?.title ?? (current().sessionID==="1" ? "Reviewing a deliberately long title across navigation, theme changes and keyboard focus" : "Pane "+current().sessionID)}</span><div class="kanban-pane-meta"><span class="kanban-pane-scope">Home</span><span class="kanban-pane-time">Just now</span></div></div><div class="kanban-pane-actions"><Show when={onActivate}><button class="kanban-pane-action kanban-pane-activate" aria-label={"Focus "+(current().entry?.title ?? current().sessionID)} onClick={onActivate}>Focus</button></Show><button class="kanban-pane-action" aria-label={"Follow "+current().sessionID} aria-pressed="false" onClick={event=>event.currentTarget.setAttribute("aria-pressed",String(event.currentTarget.getAttribute("aria-pressed")!=="true"))}>Follow</button><button class="kanban-pane-action" aria-label={"Pin "+current().sessionID}>Pin</button><span class="kanban-pane-grip">Drag</span><KanbanReorderMenu actions={[]} onReorder={()=>{}}/></div></div><div class="kanban-pane-body"><input aria-label={"Draft "+current().sessionID}/></div></div>}
    function ReadingFixture() {
      return <MarkedProvider><AppPanel.Root><AppPanel.Body><Markdown text={"## Reading section\\n\\nFeature reading body"}/></AppPanel.Body></AppPanel.Root><section data-main-conversation><Markdown text="Main conversation body"/></section></MarkedProvider>
    }
    function RefreshFixture() {
      const [entries,setEntries]=createSignal(panes.slice(0,3))
      return <div class="kanban-panel" style="height:100dvh"><button onClick={()=>setEntries(current=>current.map(item=>({...item,kind:"live",entry:{title:"Received "+item.sessionID}})))}>Receive sessions</button><button onClick={()=>setEntries(current=>current.map(item=>({...item,entry:{title:"Updated "+item.sessionID}})))}>Refresh titles</button><div class="kanban-body">{location.search.includes("focus") ? <KanbanFocus panes={entries()} renderPane={pane} railWidth={()=>300} onRailResize={()=>{}} /> : <KanbanGrid panes={entries()} cols={3} rows={1} renderPane={pane} onReorder={()=>{}} />}</div></div>
    }
    function ComposerFixture() {
      const [result,setResult]=createSignal("")
      return <><KanbanPaneComposer sessionID="fixture" agents={[{name:"synergy",mode:"primary",hidden:false}]} session={{controlProfile:"guarded"}} onSend={async text=>{setResult(text);throw new Error("Controlled send failure")}} onUpdateProfile={async()=>{}} onSetWorkflow={async()=>{}} /><output>{result()}</output></>
    }
    function ReorderFixture() {
      const [order,setOrder]=createSignal("initial")
      const disabled=location.search.includes("locked")
      document.documentElement.style.overflow="hidden"
      return <div style="height:200px;overflow:auto"><KanbanReorderMenu actions={[{id:"previous",label:"Move earlier",disabled:true},{id:"last",label:"Move to end",disabled,target:disabled?undefined:"last"}]} onReorder={setOrder}/><output>{order()}</output></div>
    }
    function MotionFixture() {
      const [entries,setEntries]=createSignal([{key:"a"},{key:"b"},{key:"c"}])
      return <><button onClick={()=>setEntries(current=>[...current].reverse())}>Reverse panels</button><FlipPanes entries={entries()} style={{display:"flex","flex-direction":"column",height:"400px"}}><For each={entries()}>{entry=><div data-pane-key={entry.key} style="height:100px;flex:none">{entry.key}</div>}</For></FlipPanes></>
    }
    render(()=> <I18nProvider i18n={i18n}>{location.search.includes("reading") ? <ReadingFixture/> : location.search.includes("refresh") ? <RefreshFixture/> : location.search.includes("motion") ? <MotionFixture/> : location.search.includes("reorder") ? <ReorderFixture/> : location.search.includes("composer") ? <ComposerFixture /> : <div class="kanban-panel" style="height:100dvh"><output>4 columns, 2 rows</output><div class="kanban-body">{location.search.includes("focus") ? <KanbanFocus panes={panes} renderPane={pane} railWidth={()=>300} onRailResize={()=>{}} /> : <KanbanGrid panes={panes} cols={4} rows={2} renderPane={pane} onReorder={()=>{}} />}</div></div>}</I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("responsive grid preserves drafts and the preferred layout while fitting the available pane width", async () => {
  await page.goto(url)
  const grid = page.locator(".kanban-grid")
  const columns = () => grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)
  await page.getByRole("textbox", { name: "Draft 0", exact: true }).fill("Retained draft")
  expect(await columns()).toBe(4)
  await page.setViewportSize({ width: 600, height: 900 })
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".kanban-grid")!).gridTemplateColumns.split(" ").length === 1,
  )
  expect(await page.getByRole("textbox", { name: "Draft 0", exact: true }).inputValue()).toBe("Retained draft")
  expect(await page.locator("output").textContent()).toBe("4 columns, 2 rows")
  await page.setViewportSize({ width: 950, height: 900 })
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".kanban-grid")!).gridTemplateColumns.split(" ").length === 3,
  )
  expect(
    await grid
      .locator(".kanban-grid-cell")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(280)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".kanban-grid")!).gridTemplateColumns.split(" ").length === 4,
  )
  expect(await page.getByRole("textbox", { name: "Draft 0", exact: true }).inputValue()).toBe("Retained draft")
})

test("narrow focus mode exposes a horizontal selector and keeps its draft readable", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${url}?focus`)
  const main = page.locator(".kanban-focus-main")
  await main.getByRole("textbox", { name: "Draft 0", exact: true }).fill("Focus draft")
  const selectors = page.locator(".kanban-focus-promote")
  const bounds = await selectors.evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().y))
  expect(new Set(bounds).size).toBe(1)
  const rail = selectors.first()
  expect(await rail.boundingBox().then((box) => box!.width)).toBeLessThanOrEqual(280)
  const actions = await rail.locator(".kanban-pane-actions button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const head = button.closest(".kanban-pane-head")!.getBoundingClientRect()
      const bounds = button.getBoundingClientRect()
      return {
        width: bounds.width,
        height: bounds.height,
        inside:
          bounds.left >= head.left &&
          bounds.right <= head.right &&
          bounds.top >= head.top &&
          bounds.bottom <= head.bottom,
      }
    }),
  )
  expect(actions.length).toBe(4)
  expect(actions.every((action) => action.width >= 44 && action.height >= 44 && action.inside)).toBe(true)
  expect(await main.boundingBox().then((box) => box!.width)).toBeGreaterThan(280)
  expect(await main.getByRole("textbox", { name: "Draft 0", exact: true }).inputValue()).toBe("Focus draft")
})

test("keyboard activation of a rail action does not promote its pane", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${url}?focus`)
  const main = page.locator(".kanban-focus-main")
  const follow = page.getByRole("button", { name: "Follow 1", exact: true })
  const activate = page.getByRole("button", { name: "Focus 1", exact: true })
  expect(await activate.evaluate((element) => !!element.closest(".kanban-pane-actions"))).toBe(true)
  await follow.press("Enter")
  expect(await follow.getAttribute("aria-pressed")).toBe("true")
  expect(await main.getAttribute("data-pane-key")).toBe("pane-0")
  await follow.press("Space")
  expect(await follow.getAttribute("aria-pressed")).toBe("false")
  expect(await main.getAttribute("data-pane-key")).toBe("pane-0")
})

test("board composer has one native focus entry per selector and names its send controls", async () => {
  await page.goto(`${url}?composer`)
  const triggers = page.locator('[data-slot="popover-trigger"]')
  expect(await triggers.count()).toBe(3)
  expect(await triggers.evaluateAll((elements) => elements.every((element) => element.tagName === "BUTTON"))).toBe(true)
  const input = page.getByRole("textbox", { name: "Message this session" })
  await input.fill("Retained after failure")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  expect(await input.inputValue()).toBe("Retained after failure")
  await triggers.nth(1).click()
  expect(await page.getByRole("radio", { name: "Guarded", exact: true }).isChecked()).toBe(true)
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="popover-trigger"]')[1] === document.activeElement,
  )
})

test("pane context stays readable over a completion status surface", async () => {
  await page.goto(url)
  const scope = page.locator(".kanban-pane-scope").first()
  await scope.waitFor()
  expect(await renderedTextContrast(scope)).toBeGreaterThanOrEqual(4.5)
  expect(await renderedTextContrast(page.locator(".kanban-pane-time").first())).toBeGreaterThanOrEqual(4.5)
})

test("panel ordering works inside the workbench scroll container and returns keyboard focus", async () => {
  await page.goto(`${url}?reorder`)
  const trigger = page.getByRole("button", { name: "Session panel actions", exact: true })
  await trigger.press("Enter")
  await page.getByRole("menuitem", { name: "Move to end", exact: true }).press("Enter")
  expect(await page.locator("output").textContent()).toBe("last")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Session panel actions")
  expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
  for (const key of ["Space", "ArrowDown", "ArrowUp"]) {
    await trigger.press(key)
    await page.getByRole("menuitem", { name: "Move to end", exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Move to end")
    expect(
      await page
        .getByRole("menuitem", { name: "Move to end", exact: true })
        .evaluate((element) => document.activeElement === element),
    ).toBe(true)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Session panel actions")
  }
  await page.goto(`${url}?reorder&locked`)
  await page.getByRole("button", { name: "Session panel actions", exact: true }).press("Enter")
  await page.keyboard.press("Escape")
  expect(await page.getByRole("menuitem").count()).toBe(0)
})

interface MotionFixtureWindow extends Window {
  panelAnimations: Animation[]
}

test("live motion preference changes cancel movement and resume without stagger", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(`${url}?motion`)
  await page.getByRole("button", { name: "Reverse panels", exact: true }).waitFor()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.evaluate(() => {
    const fixture = window as unknown as MotionFixtureWindow
    fixture.panelAnimations = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function (...arguments_) {
      const animation = animate.apply(this, arguments_)
      if (this.hasAttribute("data-pane-key")) {
        fixture.panelAnimations.push(animation)
        animation.pause()
      }
      return animation
    }
  })
  await page.getByRole("button", { name: "Reverse panels", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as MotionFixtureWindow).panelAnimations.length > 0)
  const timing = await page.evaluate(() =>
    (window as unknown as MotionFixtureWindow).panelAnimations.map((animation) => animation.effect!.getTiming()),
  )
  expect(timing.every((item) => item.duration === 240 && item.delay === 0)).toBe(true)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForFunction(() =>
    (window as unknown as MotionFixtureWindow).panelAnimations.every((animation) => animation.playState === "idle"),
  )
  await page.getByRole("button", { name: "Reverse panels", exact: true }).click()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => (window as unknown as MotionFixtureWindow).panelAnimations.length)).toBe(
    timing.length,
  )
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.getByRole("button", { name: "Reverse panels", exact: true }).click()
  await page.waitForFunction(
    (count) => (window as unknown as MotionFixtureWindow).panelAnimations.length > count,
    timing.length,
  )
  await page.evaluate(() =>
    (window as unknown as MotionFixtureWindow).panelAnimations.forEach((animation) => animation.cancel()),
  )
})

for (const mode of ["grid", "focus"]) {
  test(`${mode} panes accept late session data and refresh their titles without replacing drafts`, async () => {
    const lifecycleBrowser = await chromium.launch({ headless: true })
    const page = await lifecycleBrowser.newPage({ viewport: { width: 1280, height: 812 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(`${url}?refresh&${mode}`)
      const draft = page.getByRole("textbox", { name: "Draft 0", exact: true })
      const input = await draft.elementHandle()
      await draft.fill("Retained during navigation refresh")
      await page.getByRole("button", { name: "Receive sessions", exact: true }).click()
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll(".fixture-title")).every((element) =>
          element.textContent?.startsWith("Received"),
        ),
      )
      expect(await page.locator('.kanban-pane[data-kind="live"]').count()).toBe(3)
      await page.getByRole("button", { name: "Refresh titles", exact: true }).click()
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll(".fixture-title")).every((element) =>
          element.textContent?.startsWith("Updated"),
        ),
      )
      expect(await input!.evaluate((element) => element === document.querySelector('[aria-label="Draft 0"]'))).toBe(
        true,
      )
      expect(await draft.inputValue()).toBe("Retained during navigation refresh")
      if (mode === "focus") {
        await page.getByRole("button", { name: "Focus Updated 1", exact: true }).click()
        const main = page.locator(".kanban-focus-main")
        expect(await main.locator(".fixture-title").textContent()).toBe("Updated 1")
        expect(await main.getByRole("textbox").getAttribute("aria-label")).toBe("Draft 1")
        await page.waitForFunction(() => !!document.activeElement?.closest(".kanban-focus-main"))
      }
      expect(errors).toEqual([])
    } finally {
      await lifecycleBrowser.close()
    }
  })
}

test("feature reading typography applies to the real Markdown renderer without changing the main conversation", async () => {
  const readingBrowser = await chromium.launch({ headless: true })
  try {
    const page = await readingBrowser.newPage({ viewport: { width: 1280, height: 812 } })
    await page.goto(`${url}?reading`)
    const body = page.locator('.app-panel [data-component="markdown"] p')
    await body.waitFor()
    expect(
      await body.evaluate((element) => ({
        size: getComputedStyle(element).fontSize,
        line: getComputedStyle(element).lineHeight,
      })),
    ).toEqual({ size: "14px", line: "22px" })
    expect(
      await page.locator('.app-panel [data-component="markdown"] h2').evaluate((element) => ({
        size: getComputedStyle(element).fontSize,
        line: getComputedStyle(element).lineHeight,
      })),
    ).toEqual({ size: "16px", line: "22px" })
    expect(
      await page
        .locator('[data-main-conversation] [data-component="markdown"]')
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("16px")
  } finally {
    await readingBrowser.close()
  }
})
