import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, webkit, type Browser, type Page } from "playwright"
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
    `import { setupI18n } from "@lingui/core"; import { createSignal } from "solid-js"; import { createReactiveI18n } from ${JSON.stringify(`/@fs/${source}/context/locale/reactive-i18n.ts`)}; import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}; import { messages as zh } from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}; const i18n = setupI18n({locale:new URLSearchParams(location.search).get("locale") ?? "en",messages:{en,"zh-CN":zh}}); const [generation, setGeneration] = createSignal(0); const reactive = createReactiveI18n(i18n, generation); export const useLocale = () => ({i18n:reactive}); export const setLocale = value => {i18n.activate(value);setGeneration(value=>value+1)}; export {i18n}`,
  )
  await Bun.write(path.join(directory, "decisions.tsx"), "export const SessionDecisionOutlet = () => null")
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { For, createMemo, createSignal, onCleanup } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { applyThemeToDocument, resolveThemeVariant, synergyTheme } from "@ericsanchezok/synergy-ui/theme"
    const theme = mode => applyThemeToDocument(document, resolveThemeVariant(synergyTheme[mode]), mode, "synergy")
    theme("light")
    import { i18n, setLocale } from "./locale"
    import { PromptDock } from "@/components/session/prompt-dock"
    import { PendingComposerQueue } from "@/components/session/pending-composer-queue"
    import { selectPendingTimelineItems } from "@/components/session/conversation-pending"
    import { createPromptDockHeight } from "@/components/session/prompt-dock-height"
    import { DefaultSession } from "@/plugin/default-session"
    import { ConversationPresentation } from "@/components/session/conversation-presentation"
    import { ConversationViewport } from "@/components/session/conversation-viewport"
    import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
    import { ComposerPresentation, bindComposerPresentation } from "@/components/prompt-input/composer-presentation"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    const make = (id, mode = "task") => ({id, sessionID:"s1", messageID:"m-"+id, mode, summary:{title:"Queued "+id}, message:{origin:{type:"user"},parts:[{type:"text",text:"Queued "+id}]}, time:{created:1},orderKey:id})
    const scrolling = location.search === "?scroll"
    const [items, setItems] = createSignal(scrolling ? [] : [make("one")])
    const [messages, setMessages] = createSignal([])
    const [rollback, setRollback] = createSignal(false)
    const [root, setRoot] = createSignal(true)
    const [session, setSession] = createSignal("s1")
    const [height, setHeight] = createSignal(0)
    const [replies, setReplies] = createSignal(Array.from({length:40}, (_,i) => "Reply "+i))
    const visible = createMemo(() => selectPendingTimelineItems(items(), messages()))
    const presentation = new ComposerPresentation()
    const input = {
      current: () => ({mode:"normal",revision:1}), readOnly: () => false, dragging: () => false, className: () => "",
      composing: () => false,
      primaryAction: () => "send", render: slot => slot === "toolbar" ? <div style={{height:"48px"}} /> : null,
      editor: {label: () => "Composer", mount: () => () => {}, placeholder: () => "Write a message", completion: () => undefined},
    }
    onCleanup(bindComposerPresentation(input, {state:presentation, preview: () => ({text:"",references:[]})}))
    window.fixture = {theme, locale: setLocale, setMessage: (parts, metadata) => setItems([{...make("media"),message:{origin:{type:"user"},parts,metadata}}]), editCalls: 0, setItems: (count) => setItems(Array.from({length:count}, (_,i) => make(String(i)))), deliver: () => setMessages(items().map(item => ({id:item.messageID}))), rollback:setRollback, root:setRoot, mode: mode => setItems(items().map(item => ({...item,mode}))), fail: () => setItems(items().map(item => ({...item,status:"failed"}))), expand: () => presentation.expand(), collapse: () => presentation.collapse(), switch: () => {setSession("s2");setItems([make("other")]);setMessages([])}, append: () => setReplies([...replies(), "New output"]), guideCalls:0, removeCalls:0, hold:false}
    const guide = async () => {window.fixture.guideCalls++; if(window.fixture.hold) await new Promise(resolve => window.fixture.finish = resolve)}
    const dock = createPromptDockHeight(setHeight)
    const renderDock = () => <PromptDock context={{input:()=>input,mount:dock.mount,ready:()=>true,readOnly:()=>false,links:()=>[],render:()=>null}} pending={<PendingComposerQueue identity={session()} items={visible()} rollbackActive={rollback()} hasCanonicalRoot={root()} serverUrl={location.origin} onEdit={async item => {window.fixture.editCalls++;setItems(items().filter(value=>value.id!==item.id))}} onGuide={guide} onRemove={async item => {window.fixture.removeCalls++;setItems(items().filter(value=>value.id!==item.id))}} />} />
    render(() => {
      if (!scrolling) return <I18nProvider i18n={i18n}><MarkedProvider><div class="session-workbench-pane" style={{height:"100dvh",position:"relative"}} data-height={height()}>
        <div data-conversation-current><div data-session-top-bar style={{height:"48px"}} /><p>Current answer</p></div>{renderDock()}
      </div></MarkedProvider></I18nProvider>
      const autoScroll = createAutoScroll({working:()=>false})
      window.fixture.latest = () => autoScroll.forceScrollToBottom({untilInteraction:true})
      window.fixture.reading = autoScroll.userScrolled
      return <I18nProvider i18n={i18n}><MarkedProvider><div style={{height:"100dvh"}} data-height={height()}>
        <DefaultSession context={{layout:{minimumWidth:()=>undefined,promptHeight:height,render:part=>part === "composer" ? renderDock() : part === "conversation" ?
          <ConversationPresentation owner={["server","scope",session()]} ready={true}><div class="flex-1 min-h-0 flex flex-col">
            <ConversationViewport scrolledUp={autoScroll.userScrolled()} onScrolledUpChange={()=>{}} autoScroll={autoScroll} setScrollRef={autoScroll.scrollRef} contentClass="session-conversation-content session-content-column flex flex-col items-start justify-start gap-5 pb-6 md:pb-[calc(var(--prompt-height,10rem)+32px)]">
              <For each={replies()}>{reply=><p style={{height:"48px",margin:"0"}}>{reply}</p>}</For>
            </ConversationViewport>
          </div></ConversationPresentation> : null}}} />
      </div></MarkedProvider></I18nProvider>
    }, document.querySelector("#root"))
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
  browser = await (process.env.SYNERGY_TEST_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface Fixture {
  theme(mode: "light" | "dark"): void
  locale(value: "en" | "zh-CN"): void
  setMessage(parts: Array<Record<string, unknown>>, metadata?: Record<string, unknown>): void
  editCalls: number
  setItems(count: number): void
  deliver(): void
  rollback(value: boolean): void
  root(value: boolean): void
  mode(value: string): void
  fail(): void
  expand(): void
  collapse(): void
  switch(): void
  append(): void
  latest(): void
  reading(): boolean
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
  expect(await page.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail())
  await page.getByRole("button", { name: "Delete", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rollback(true))
  expect(await page.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rollback(false))
  await page.getByRole("button", { name: "Delete", exact: true }).click()
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
  const action = page.getByRole("button", { name: "Delete", exact: true }).last()
  await action.focus()
  expect(
    await action.evaluate((element) => {
      const r = element.getBoundingClientRect()
      return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("queued media, references and editing stay readable in both locales and themes at narrow widths", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(server.url + "?locale=zh-CN")
  await page.getByRole("button", { name: "编辑消息", exact: true }).waitFor()
  await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 160
    canvas.height = 100
    const paint = canvas.getContext("2d")!
    paint.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--surface-inset-base")
    paint.fillRect(0, 0, canvas.width, canvas.height)
    paint.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-weak")
    paint.lineWidth = 3
    paint.strokeRect(16, 30, 40, 40)
    paint.strokeRect(104, 30, 40, 40)
    paint.beginPath()
    paint.moveTo(56, 50)
    paint.lineTo(104, 50)
    paint.stroke()
    ;(window as unknown as { fixture: Fixture }).fixture.setMessage(
      [
        { type: "text", text: "Review this diagram and recording" },
        { type: "attachment", id: "image", mime: "image/png", filename: "diagram.png", url: canvas.toDataURL() },
        { type: "attachment", id: "audio", mime: "audio/wav", filename: "recording.wav", url: "asset://recording.wav" },
        { type: "attachment", id: "pdf", mime: "application/pdf", filename: "notes.pdf", url: "asset://notes.pdf" },
      ],
      {
        promptDraft: {
          version: 1,
          prompt: [
            { type: "text", content: "Review this diagram and recording", start: 0, end: 33 },
            { type: "note", id: "note", noteId: "nte_plan", title: "Implementation plan", content: "Retain note" },
            { type: "session", id: "session", sessionId: "ses_previous", scopeID: "home", title: "Previous task" },
          ],
          context: { items: [{ type: "file", path: "src/file.ts" }] },
        },
      },
    )
  })
  const queue = page.locator(".pending-composer-queue")
  await queue.locator('[data-component="attachment-card"]').first().waitFor()
  expect(await queue.locator('[data-component="attachment-card"]').count()).toBe(3)
  expect(await queue.getByText("notes.pdf", { exact: true }).count()).toBe(1)
  expect(await queue.getByText("recording.wav", { exact: true }).count()).toBe(1)
  for (const reference of ["Implementation plan", "Previous task", "src/file.ts"]) {
    expect(await queue.getByText(reference, { exact: true }).count()).toBe(1)
  }
  expect(
    await queue.locator("img").evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      return image.naturalWidth
    }),
  ).toBeGreaterThan(0)
  const backgrounds: string[] = []
  const output = process.env.SYNERGY_SURFACE_SCREENSHOTS
  if (output) await mkdir(output, { recursive: true })
  for (const locale of ["zh-CN", "en"] as const) {
    await page.evaluate((locale) => (window as unknown as { fixture: Fixture }).fixture.locale(locale), locale)
    await queue.getByRole("button", { name: locale === "en" ? "Edit message" : "编辑消息", exact: true }).waitFor()
    const deletion = queue.getByRole("button", { name: locale === "en" ? "Delete" : "删除", exact: true })
    expect(await deletion.getAttribute("title")).toBe(locale === "en" ? "Delete" : "删除")
    for (const width of [375, 1000]) {
      await page.setViewportSize({ width, height: 812 })
      for (const mode of ["light", "dark"] as const) {
        await page.evaluate((mode) => (window as unknown as { fixture: Fixture }).fixture.theme(mode), mode)
        if (locale === "en" && width === 375) {
          backgrounds.push(await queue.evaluate((element) => getComputedStyle(element).backgroundColor))
        }
        const geometry = await queue.evaluate((element) => {
          const actions = Array.from(element.querySelectorAll<HTMLElement>(".pending-composer-actions button"))
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            reachable: actions.every((node) => {
              const rect = node.getBoundingClientRect()
              return rect.left >= 0 && rect.right <= innerWidth && rect.height >= (innerWidth < 768 ? 44 : 32)
            }),
          }
        })
        expect(geometry.overflow).toBe(false)
        expect(geometry.reachable).toBe(true)
        if (output && locale === "zh-CN") {
          await page
            .locator(".session-prompt-dock")
            .screenshot({ path: path.join(output, `pending-${mode}-${width}.png`) })
        }
      }
    }
  }
  expect(backgrounds[0]).not.toBe(backgrounds[1])
  const edit = queue.getByRole("button", { name: "Edit message", exact: true })
  await edit.focus()
  expect(await edit.evaluate((element) => element === document.activeElement)).toBe(true)
  await edit.press("Enter")
  await queue.waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.editCalls)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.removeCalls)).toBe(0)
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

test("pane height changes during expansion invalidate captured Composer geometry", async () => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(server.url)
  await page.getByRole("region", { name: "Inbox", exact: true }).waitFor()
  await page.waitForFunction(() => Number(document.querySelector("[data-height]")?.getAttribute("data-height")) > 100)
  const geometry = await page.evaluate(async () => {
    ;(window as unknown as { fixture: Fixture }).fixture.expand()
    document.querySelector<HTMLElement>(".session-workbench-pane")!.style.height = "500px"
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const composer = document.querySelector<HTMLElement>(".session-composer")!
    return { motion: composer.getAttribute("data-motion"), animations: composer.getAnimations().length }
  })
  expect(geometry.motion).toBeNull()
  expect(geometry.animations).toBe(0)
  expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()
})

for (const width of [375, 1000]) {
  test(`late pending input preserves settled latest following at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 640 })
    await page.goto(server.url + "?scroll")
    await page.locator("[data-conversation-viewport]").waitFor()
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.latest())
    const viewport = page.locator("[data-conversation-viewport]")
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-conversation-viewport]")!
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    await page.waitForTimeout(1100)
    const before = await viewport.evaluate((el) => {
      const content = el.querySelector<HTMLElement>(".session-conversation-content")!
      const padding = Number.parseFloat(getComputedStyle(content).paddingBottom)
      return {
        padding,
        contentHeight: content.getBoundingClientRect().height - padding,
        rows: content.firstElementChild!.childElementCount,
      }
    })
    const clientHeight = await viewport.evaluate((el) => el.clientHeight)
    const geometry = await page.evaluate(async () => {
      const f = (window as unknown as { fixture: Fixture }).fixture
      f.setItems(12)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const el = document.querySelector("[data-conversation-viewport]")!
      const content = el.querySelector<HTMLElement>(".session-conversation-content")!
      const padding = Number.parseFloat(getComputedStyle(content).paddingBottom)
      return {
        clientHeight: el.clientHeight,
        gap: el.scrollHeight - el.clientHeight - el.scrollTop,
        reading: f.reading(),
        padding,
        contentHeight: content.getBoundingClientRect().height - padding,
        rows: content.firstElementChild!.childElementCount,
      }
    })
    if (width < 768) expect(geometry.clientHeight).toBeLessThan(clientHeight)
    else {
      expect(geometry.clientHeight).toBe(clientHeight)
      expect(geometry.padding).toBeGreaterThan(before.padding)
      expect(geometry.contentHeight).toBeCloseTo(before.contentHeight, 0)
    }
    expect(geometry.rows).toBe(before.rows)
    expect(geometry.gap).toBeLessThan(2)
    expect(geometry.reading).toBe(false)
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.append())
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-conversation-viewport]")!
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    expect(await viewport.count()).toBe(1)
    expect(await viewport.locator("[data-slot=pending-timeline-item]").count()).toBe(0)
  })

  test(`a native scroll-away remains reading through queue mount and delivery at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 640 })
    await page.goto(server.url + "?scroll")
    await page.locator("[data-conversation-viewport]").waitFor()
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.latest())
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-conversation-viewport]")!
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    const viewport = page.locator("[data-conversation-viewport]")
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -320)
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-conversation-viewport]")!
      return el.scrollHeight - el.clientHeight - el.scrollTop > 200
    })
    const offset = await viewport.evaluate((el) => el.scrollTop)
    const reading = await page.evaluate(async () => {
      const f = (window as unknown as { fixture: Fixture }).fixture
      f.setItems(12)
      f.append()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return f.reading()
    })
    expect(reading).toBe(true)
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(offset, 0)
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.deliver())
    await page.getByRole("region", { name: "Inbox", exact: true }).waitFor({ state: "detached" })
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(offset, 0)
  })
}

for (const lock of ["rollback", "first-task"] as const) {
  test(`keyboard-only scrolling reaches the last frozen queue message during ${lock}`, async () => {
    await page.setViewportSize({ width: 375, height: 640 })
    await page.goto(server.url)
    await page.getByRole("region", { name: "Inbox", exact: true }).waitFor()
    await page.evaluate((lock) => {
      const f = (window as unknown as { fixture: Fixture }).fixture
      f.setItems(12)
      if (lock === "rollback") f.rollback(true)
      else f.root(false)
    }, lock)
    const list = page.locator(".pending-composer-list")
    expect(await list.locator("button").count()).toBe(0)
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await page.keyboard.press("Tab")
    expect(await list.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await list.getAttribute("role")).toBe("group")
    expect(await list.getAttribute("aria-label")).toBe("Inbox")
    expect(await list.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
    expect(await list.evaluate((el) => getComputedStyle(el).backgroundImage)).not.toBe("none")
    await page.keyboard.press("End")
    await page.waitForFunction(() => {
      const el = document.querySelector(".pending-composer-list")!
      return el.scrollHeight - el.clientHeight - el.scrollTop < 1
    })
    const end = await list.evaluate((el) => {
      const bounds = el.lastElementChild!.querySelector(".pending-composer-label")!.getBoundingClientRect()
      const viewport = el.getBoundingClientRect()
      return {
        gap: el.scrollHeight - el.clientHeight - el.scrollTop,
        top: bounds.top - viewport.top,
        bottom: viewport.bottom - bounds.bottom,
      }
    })
    expect(end.gap).toBeLessThan(1)
    expect(end.top).toBeGreaterThanOrEqual(0)
    expect(end.bottom).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.removeCalls)).toBe(0)
  })
}
