import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".pending-composer-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `import { setupI18n } from "@lingui/core"; const i18n = setupI18n({locale:"en",messages:{}}); export const useLocale = () => ({i18n}); export {i18n}`,
  )
  await Bun.write(path.join(directory, "decisions.tsx"), "export const SessionDecisionOutlet = () => null")
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createMemo, createSignal, onCleanup } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { i18n } from "./locale"
    import { PromptDock } from "@/components/session/prompt-dock"
    import { PendingComposerQueue } from "@/components/session/pending-composer-queue"
    import { selectPendingTimelineItems } from "@/components/session/conversation-pending"
    import { createPromptDockHeight } from "@/components/session/prompt-dock-height"
    import { ComposerPresentation, bindComposerPresentation } from "@/components/prompt-input/composer-presentation"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    const make = (id, mode = "task") => ({id, sessionID:"s1", messageID:"m-"+id, mode, summary:{title:"Queued "+id}, message:{origin:{type:"user"},parts:[{type:"text",text:"Queued "+id}]}, time:{created:1},orderKey:id})
    const [items, setItems] = createSignal([make("one")])
    const [messages, setMessages] = createSignal([])
    const [rollback, setRollback] = createSignal(false)
    const [root, setRoot] = createSignal(true)
    const [session, setSession] = createSignal("s1")
    const [height, setHeight] = createSignal(0)
    const visible = createMemo(() => selectPendingTimelineItems(items(), messages()))
    const presentation = new ComposerPresentation()
    const input = {
      current: () => ({mode:"normal",revision:1}), readOnly: () => false, dragging: () => false, className: () => "",
      composing: () => false,
      primaryAction: () => "send", render: slot => slot === "toolbar" ? <div style={{height:"48px"}} /> : null,
      editor: {label: () => "Composer", mount: () => () => {}, placeholder: () => "Write a message", completion: () => undefined},
    }
    onCleanup(bindComposerPresentation(input, {state:presentation, preview: () => ({text:"",references:[]})}))
    window.fixture = {setItems: (count) => setItems(Array.from({length:count}, (_,i) => make(String(i)))), deliver: () => setMessages(items().map(item => ({id:item.messageID}))), rollback:setRollback, root:setRoot, mode: mode => setItems(items().map(item => ({...item,mode}))), fail: () => setItems(items().map(item => ({...item,status:"failed"}))), expand: () => presentation.expand(), collapse: () => presentation.collapse(), switch: () => {setSession("s2");setItems([make("other")]);setMessages([])}, guideCalls:0, removeCalls:0, hold:false}
    const guide = async () => {window.fixture.guideCalls++; if(window.fixture.hold) await new Promise(resolve => window.fixture.finish = resolve)}
    const dock = createPromptDockHeight(setHeight)
    render(() => <I18nProvider i18n={i18n}><MarkedProvider><div class="session-workbench-pane" style={{height:"100dvh",position:"relative"}} data-height={height()}>
      <div data-conversation-current><div data-session-top-bar style={{height:"48px"}} /><p>Current answer</p></div>
      <PromptDock context={{input:()=>input,mount:dock.mount,ready:()=>true,readOnly:()=>false,links:()=>[],render:()=>null}} pending={<PendingComposerQueue identity={session()} items={visible()} rollbackActive={rollback()} hasCanonicalRoot={root()} onGuide={guide} onRemove={async item => {window.fixture.removeCalls++;setItems(items().filter(value=>value.id!==item.id))}} />} />
    </div></MarkedProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
      { find: /.*\/decision-surface$/, replacement: path.join(directory, "decisions.tsx") },
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface Fixture {
  setItems(count: number): void
  deliver(): void
  rollback(value: boolean): void
  root(value: boolean): void
  mode(value: string): void
  fail(): void
  expand(): void
  collapse(): void
  switch(): void
  guideCalls: number
  removeCalls: number
  hold: boolean
  finish(): void
}

test("pending messages attach to the measured dock, not the answer, and delivery leaves no queue space", async () => {
  await page.goto(server.url)
  const queue = page.getByRole("region", { name: "Inbox", exact: true })
  await queue.waitFor()
  expect(await page.locator("[data-conversation-current] [data-slot=pending-timeline-item]").count()).toBe(0)
  const before = await page.locator(".session-prompt-dock").boundingBox()
  const queueBox = await queue.boundingBox()
  const availableBefore = await page
    .locator(".session-composer")
    .evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.getPropertyValue("--composer-available-height")),
    )
  const inputBox = await page.locator(".prompt-input-shell").boundingBox()
  expect(queueBox!.y).toBeLessThan(inputBox!.y)
  expect(queueBox!.y + queueBox!.height - inputBox!.y).toBeGreaterThanOrEqual(0)
  await page.waitForFunction(() => Number(document.querySelector("[data-height]")?.getAttribute("data-height")) > 100)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.deliver())
  await queue.waitFor({ state: "detached" })
  const after = await page.locator(".session-prompt-dock").boundingBox()
  await page.waitForFunction((previous) => {
    const element = document.querySelector<HTMLElement>(".session-composer")!
    return Number.parseFloat(element.style.getPropertyValue("--composer-available-height")) > previous
  }, availableBefore)
  const availableAfter = await page
    .locator(".session-composer")
    .evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.getPropertyValue("--composer-available-height")),
    )
  expect(availableAfter - availableBefore).toBeCloseTo(before!.height - after!.height, 0)
  expect(after!.height).toBeLessThan(before!.height)
  expect(after!.y + after!.height).toBeCloseTo(before!.y + before!.height, 0)
})

test("mode updates retain controls and pending operations cannot leak across session switching", async () => {
  await page.goto(server.url)
  await page.getByRole("button", { name: "Guide", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.mode("steer"))
  const queueAction = page.getByRole("button", { name: "Queue", exact: true })
  await queueAction.focus()
  await page.evaluate(() => {
    const f = (window as unknown as { fixture: Fixture }).fixture
    f.mode("steer")
    f.hold = true
  })
  expect(await queueAction.evaluate((element) => element === document.activeElement)).toBe(true)
  await queueAction.press("Enter")
  await page.locator(".pending-composer-feedback[role=status]").waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.switch())
  expect(await page.locator(".pending-composer-feedback[role=status]").count()).toBe(0)
  await page.getByRole("button", { name: "Guide", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.finish())
  expect(await page.getByRole("button", { name: "Guide", exact: true }).isEnabled()).toBe(true)
})

test("first-task lock, failed withdrawal and rollback retain their existing semantics", async () => {
  await page.goto(server.url)
  await page.getByRole("region", { name: "Inbox", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.root(false))
  expect(await page.getByRole("button", { name: "Guide", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Withdraw", exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail())
  await page.getByRole("button", { name: "Withdraw", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rollback(true))
  expect(await page.getByRole("button", { name: "Withdraw", exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rollback(false))
  await page.getByRole("button", { name: "Withdraw", exact: true }).click()
  expect(await page.getByRole("region", { name: "Inbox", exact: true }).count()).toBe(0)
})

test("many queued rows stay bounded and all actions remain reachable at narrow and short geometry", async () => {
  await page.goto(server.url)
  await page.getByRole("region", { name: "Inbox", exact: true }).waitFor()
  await page.setViewportSize({ width: 375, height: 640 })
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.setItems(12))
  const list = page.locator(".pending-composer-list")
  await page.waitForFunction(() => {
    const el = document.querySelector(".pending-composer-list")
    return el && el.scrollHeight > el.clientHeight
  })
  expect((await list.boundingBox())!.height).toBeLessThanOrEqual(180)
  const action = page.getByRole("button", { name: "Withdraw", exact: true }).last()
  await action.focus()
  expect(
    await action.evaluate((element) => {
      const r = element.getBoundingClientRect()
      return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("pending input preserves the Composer expansion and collapse motion", async () => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(server.url)
  await page.getByRole("region", { name: "Inbox", exact: true }).waitFor()
  await page.waitForFunction(() => Number(document.querySelector("[data-height]")?.getAttribute("data-height")) > 100)
  const expanding = await page.evaluate(async () => {
    ;(window as unknown as { fixture: Fixture }).fixture.expand()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return document.querySelector(".session-composer")!.getAnimations().length
  })
  expect(expanding).toBeGreaterThan(0)
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
  expect(await page.getByRole("region", { name: "Inbox", exact: true }).isVisible()).toBe(false)
  const collapsing = await page.evaluate(async () => {
    ;(window as unknown as { fixture: Fixture }).fixture.collapse()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return document.querySelector(".session-composer")!.getAnimations().length
  })
  expect(collapsing).toBeGreaterThan(0)
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
  await page.getByRole("region", { name: "Inbox", exact: true }).waitFor({ state: "visible" })
  expect(errors).toEqual([])
})
