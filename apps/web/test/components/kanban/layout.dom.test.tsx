import { renderedTextContrast } from "../../testing/rendered-text-contrast"
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

setDefaultTimeout(30000)
let browser: Browser
let page: Page
let fixture: BrowserFixture
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
    export const useGlobalSDK=()=>({capabilities:{has:id=>["blueprint","lattice","boss"].includes(id)}})
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
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {MenuField} from "@ericsanchezok/synergy-ui/menu-field"
    import {IconButton} from "@ericsanchezok/synergy-ui/icon-button"
    import {getSemanticIcon} from "@ericsanchezok/synergy-ui/semantic-icon"
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
    function PresentationFixture() {
      return <ThemeProvider><main class="synergy-workbench-canvas" style="padding:16px;max-width:720px">
        <button id="presentation-start">Start</button>
        <section data-main-composer class="prompt-input-shell" style="padding:16px">
          <button class="prompt-input-toolbar-button">Reference choice</button>
          <IconButton aria-label="Reference send" disabled icon={getSemanticIcon("prompt.submitArrow")} variant="primary" class="prompt-input-submit size-[34px] rounded-full!"/>
        </section>
        <div class="kanban-panel" style="height:auto">
          <div class="kanban-grid-config"><For each={["Columns","Rows"]}>{label=><MenuField ariaLabel={label} value="2" triggerClass="menu-field-trigger kanban-grid-select" options={[{value:"2",label:"2"},{value:"3",label:"3"}]} onChange={()=>{}}/>}</For></div>
          {pane(()=>panes[0],"grid")}
          <div class="kanban-pane" style="height:auto"><ComposerFixture/></div>
        </div>
      </main></ThemeProvider>
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
    render(()=> <I18nProvider i18n={i18n}>{location.search.includes("presentation") ? <PresentationFixture/> : location.search.includes("reading") ? <ReadingFixture/> : location.search.includes("refresh") ? <RefreshFixture/> : location.search.includes("motion") ? <MotionFixture/> : location.search.includes("reorder") ? <ReorderFixture/> : location.search.includes("composer") ? <ComposerFixture /> : <div class="kanban-panel" style="height:100dvh"><output>4 columns, 2 rows</output><div class="kanban-body">{location.search.includes("focus") ? <KanbanFocus panes={panes} renderPane={pane} railWidth={()=>300} onRailResize={()=>{}} /> : <KanbanGrid panes={panes} cols={4} rows={2} renderPane={pane} onReorder={()=>{}} />}</div></div>}</I18nProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
      { find: "@/context/global-sdk", replacement: path.join(directory, "locale.ts") },
      { find: "@", replacement: source },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
}, 60000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
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
  expect(await page.getByRole("option", { name: "Guarded", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="popover-trigger"]')[1] === document.activeElement,
  )
})

test("pane context stays readable over its header surface", async () => {
  await page.goto(url)
  const scope = page.locator(".kanban-pane-scope").first()
  await scope.waitFor()
  expect(await renderedTextContrast(scope)).toBeGreaterThanOrEqual(4.5)
  expect(await renderedTextContrast(page.locator(".kanban-pane-time").first())).toBeGreaterThanOrEqual(4.5)
})

for (const mode of ["light", "dark"] as const) {
  test(`board headers stay neutral across session states in ${mode} mode`, async () => {
    await page.emulateMedia({ colorScheme: mode })
    await page.goto(`${url}?presentation`)
    const header = page.locator(".kanban-pane-head")
    await header.waitFor()
    const surface = await page
      .locator("[data-main-composer]")
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    for (const status of ["working", "waiting", "completed", ""]) {
      await header.evaluate((element, status) => element.setAttribute("data-status", status), status)
      expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor), status).toBe(surface)
      expect(await renderedTextContrast(page.locator(".kanban-pane-scope"))).toBeGreaterThanOrEqual(4.5)
      expect(await renderedTextContrast(page.locator(".kanban-pane-time"))).toBeGreaterThanOrEqual(4.5)
    }
    const follow = page.getByRole("button", { name: "Follow 0", exact: true })
    await follow.evaluate((element) => element.setAttribute("data-active", ""))
    expect(await follow.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
  })

  test(`board composer shares the main session surfaces without input interaction effects in ${mode} mode`, async () => {
    await page.emulateMedia({ colorScheme: mode })
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`${url}?presentation`)
    const input = page.getByRole("textbox", { name: "Message this session", exact: true })
    await input.waitFor()
    const surface = await page
      .locator("[data-main-composer]")
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(
      await page.locator(".kanban-pane-composer").evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(surface)
    const appearance = () =>
      input.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          background: style.background,
          border: style.border,
          shadow: style.boxShadow,
          outline: style.outlineStyle,
          color: style.color,
        }
      })
    const resting = await appearance()
    expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
    expect(await input.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px")
    expect(await input.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none")
    await input.hover()
    expect(await appearance()).toEqual(resting)
    await page.mouse.down()
    expect(await appearance()).toEqual(resting)
    await page.mouse.up()
    expect(await appearance()).toEqual(resting)
    await page.locator("#presentation-start").focus()
    await input.focus()
    expect(await appearance()).toEqual(resting)
    await page.mouse.move(0, 0)
    await page.locator("#presentation-start").focus()
    const controls = page.locator(".kanban-grid-select, .kanban-composer-chip")
    expect(await controls.count()).toBe(5)
    const choice = await page
      .getByRole("button", { name: "Reference choice" })
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    for (const control of await controls.all()) {
      expect(await control.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(choice)
      expect(await control.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none")
    }
    const send = page.getByRole("button", { name: "Send message", exact: true })
    const referenceSend = page.getByRole("button", { name: "Reference send", exact: true })
    const sendSurface = (element: Element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, shadow: style.boxShadow }
    }
    expect(await send.evaluate(sendSurface)).toEqual(await referenceSend.evaluate(sendSurface))
    expect(
      await send.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const radius = getComputedStyle(element).borderRadius
        const pixels = parseFloat(radius) * (radius.endsWith("%") ? bounds.width / 100 : 1)
        return bounds.width === bounds.height && pixels >= bounds.width / 2
      }),
    ).toBe(true)
    await input.fill("A retained board draft")
    await referenceSend.evaluate((element) => element.removeAttribute("disabled"))
    expect(await send.evaluate(sendSurface)).toEqual(await referenceSend.evaluate(sendSurface))
    for (const width of [720, 375]) {
      await page.setViewportSize({ width, height: 900 })
      const inputBounds = (await input.boundingBox())!
      const toolbarBounds = (await page.locator(".kanban-pane-composer-toolbar").boundingBox())!
      expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(toolbarBounds.y)
      for (const control of await page.locator(".kanban-composer-chip, .kanban-pane-send").all()) {
        const bounds = (await control.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        if (width === 375) expect(bounds.height).toBeGreaterThanOrEqual(44)
      }
    }
    expect(await input.inputValue()).toBe("A retained board draft")
    await page.emulateMedia({ colorScheme: "light" })
  })
}

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
  await page.getByRole("menu").waitFor({ state: "detached" })
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 812 } })
    page.setDefaultTimeout(10000)
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
      await page.close()
    }
  })
}

test("feature reading typography applies to the real Markdown renderer without changing the main conversation", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 812 } })
  page.setDefaultTimeout(10000)
  try {
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
    await page.close()
  }
})
