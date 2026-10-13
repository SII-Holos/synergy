import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser, page: Page, server: BrowserFixture, directory: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".conversation-controls-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "decision.tsx"),
    'export const SessionDecisionOutlet = () => new URLSearchParams(location.search).has("request") ? <button style="height:90px;width:100%" data-request>Permission request</button> : null',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, For, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme/context"
    import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
    import { ProcessViewport } from "@ericsanchezok/synergy-ui/process-viewport"
    import { DefaultSession } from ${JSON.stringify(`/@fs/${source}/plugin/default-session.tsx`)}
    import { PromptDock } from ${JSON.stringify(`/@fs/${source}/components/session/prompt-dock.tsx`)}
    import { createPromptDockHeight } from ${JSON.stringify(`/@fs/${source}/components/session/prompt-dock-height.ts`)}
    import { ConversationPresentation } from ${JSON.stringify(`/@fs/${source}/components/session/conversation-presentation.tsx`)}
    import { ConversationViewport } from ${JSON.stringify(`/@fs/${source}/components/session/conversation-viewport.tsx`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/session/prompt-dock-float-layer.css`)}
    function App() {
      const [height, setHeight] = createSignal(0)
      const [scrolledUp, setScrolledUp] = createSignal(false)
      const [activity, setActivity] = createSignal(true)
      const [lines, setLines] = createSignal(24)
      const dock = createPromptDockHeight(setHeight)
      const autoScroll = createAutoScroll({ working: () => true, onMeasure: distance => setScrolledUp(distance > 100) })
      const detached = () => scrolledUp() || autoScroll.userScrolled()
      window.controls = { activity: setActivity, grow: () => setLines(lines() + 8), latest: () => autoScroll.forceScrollToBottom({untilInteraction:true}) }
      const input = {
        readOnly: () => false, primaryAction: () => "send", submit: async () => {},
        dragging: () => false, className: () => "", current: () => ({ mode: "normal" }),
        setComposing: () => {}, dragOver: () => {}, dragLeave: () => {}, drop: async () => {},
        editor: { label: () => "Message", completion: () => undefined, placeholder: () => "Describe a task",
          mount: () => () => {}, beforeInput: () => {}, input: () => {}, paste: async () => {}, keyDown: () => {} },
        render: part => part === "toolbar" ? <div class="prompt-input-toolbar"><button type="submit">Send</button></div> : null,
      }
      const composer = { input: () => input, mount: dock.mount, ready: () => true, isNewSession: () => false,
        readOnly: () => false, isGlobal: () => true, pendingText: () => "", scopeName: () => "Home",
        branch: () => undefined, lastModified: () => undefined, links: () => [],
        render: part => part === "priority" ? <Show when={activity()}><div class="prompt-dock-float-layer flex flex-col items-center">
          <button style="height:52px">Agent</button><button style="height:40px;max-width:100%;overflow:hidden;white-space:nowrap" data-progress>Checking the implementation · 1/5</button>
        </div></Show> : null }
      return <div style="height:100dvh"><DefaultSession context={{layout:{minimumWidth:()=>undefined,promptHeight:height,
        render: part => part === "composer" ? <PromptDock context={composer}/> : part === "conversation" ?
          <ConversationPresentation owner={["fixture","home","session"]} ready>
            <ConversationViewport scrolledUp={detached()} onScrolledUpChange={setScrolledUp} autoScroll={autoScroll} setScrollRef={autoScroll.scrollRef}
              contentClass="session-content-column" contentClassList={{"pb-6 md:pb-[calc(var(--prompt-height,10rem)+32px)]":true}}>
              <For each={Array.from({length:lines()},(_,i)=>i)}>{i=><p style="height:36px">Conversation paragraph {i + 1}</p>}</For>
              <ProcessViewport identity="controls" active parentFollowing={!detached()} onInteraction={()=>autoScroll.handleInteraction()}>
                <For each={Array.from({length:32},(_,i)=>i)}>{i=><p style="height:32px">Reasoning and tool record {i + 1}</p>}</For>
              </ProcessViewport>
            </ConversationViewport>
          </ConversationPresentation> : null
      }}}/></div>
    }
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><ThemeProvider><App/></ThemeProvider></I18nProvider>,document.getElementById("root"))
    `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: /^\.\/decision-surface$/, replacement: path.join(directory, "decision.tsx") },
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
})
afterEach(async () => {
  await page?.close()
})
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Controls = { activity(value: boolean): void; grow(): void; latest(): void }
async function open(query = "") {
  await page.goto(server.url + query)
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { controls: Controls }).controls.latest())
  await page.waitForFunction(() => {
    const outer = document.querySelector("[data-conversation-viewport]")!
    return (
      outer.scrollHeight - outer.clientHeight - outer.scrollTop < 2 &&
      !document.querySelector("[data-conversation-latest]")
    )
  })
}
const outer = () => page.locator("[data-conversation-viewport]")
const latest = () => page.getByRole("button", { name: "Back to latest", exact: true })
const frames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )

test("reading the inner process at the outer bottom does not show the conversation latest button", async () => {
  await open()
  const process = page.getByRole("region", { name: "Process history" })
  const outerTop = await outer().evaluate((el) => el.scrollTop)
  await process.hover()
  await page.mouse.wheel(0, -160)
  await page.waitForFunction(() => {
    const inner = document.querySelector('[data-component="process-viewport"]')!
    return inner.scrollHeight - inner.clientHeight - inner.scrollTop > 100
  })
  expect(await outer().evaluate((el) => el.scrollTop)).toBeCloseTo(outerTop, 0)
  expect(await latest().count()).toBe(0)
  await process.focus()
  await process.press("Home")
  await frames()
  expect(await latest().count()).toBe(0)
  await page.evaluate(() => (window as unknown as { controls: Controls }).controls.grow())
  await latest().waitFor()
  await latest().focus()
  await latest().press("Enter")
  await latest().waitFor({ state: "detached" })
  await page.waitForFunction(() => {
    const outer = document.querySelector("[data-conversation-viewport]")!
    return outer.scrollHeight - outer.clientHeight - outer.scrollTop < 2
  })
  expect(await latest().count()).toBe(0)
  expect(errors).toEqual([])
})

test("latest stays beside the composer through activity, resizing and narrow layout", async () => {
  for (const width of [1100, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: width === 1100 ? "light" : "dark", reducedMotion: "reduce" })
    await open()
    await outer().evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }))
      el.scrollTop -= 240
    })
    await latest().waitFor()
    const editor = page.locator(".prompt-input-shell")
    const assertPosition = async () => {
      const [button, input] = await Promise.all([latest().boundingBox(), editor.boundingBox()])
      const gap = input!.y - button!.y - button!.height
      expect(gap).toBeGreaterThanOrEqual(8)
      expect(gap).toBeLessThanOrEqual(20)
      expect(Math.abs(input!.x + input!.width - button!.x - button!.width)).toBeLessThanOrEqual(1)
      expect(
        await latest().evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }),
      ).toBe(true)
    }
    await assertPosition()
    const before = await latest().boundingBox()
    await page.evaluate(() => (window as unknown as { controls: Controls }).controls.activity(false))
    await frames()
    await assertPosition()
    expect((await latest().boundingBox())!.y).toBeCloseTo(before!.y, 0)
    await page.locator(".session-composer-editor").evaluate((el) => ((el as HTMLElement).style.height = "160px"))
    await frames()
    await assertPosition()
    await latest().click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Back to latest"]'))
    expect(errors).toEqual([])
  }
}, 30_000)

test("narrow screens keep latest reachable above the stacked dock", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open()
  await outer().evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }))
    el.scrollTop -= 240
  })
  await latest().waitFor()
  const [button, dock] = await Promise.all([latest().boundingBox(), page.locator(".session-prompt-dock").boundingBox()])
  expect(dock!.y - button!.y - button!.height).toBeGreaterThanOrEqual(8)
  expect(dock!.y - button!.y - button!.height).toBeLessThanOrEqual(20)
  expect(button!.x).toBeGreaterThanOrEqual(0)
  expect(button!.x + button!.width).toBeLessThanOrEqual(375)
  await latest().click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Back to latest"]'))
})

test("latest clears a pending decision above the composer", async () => {
  await open("?request")
  await outer().evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }))
    el.scrollTop -= 240
  })
  await latest().waitFor()
  const [button, request] = await Promise.all([latest().boundingBox(), page.locator("[data-request]").boundingBox()])
  expect(request!.y - button!.y - button!.height).toBeGreaterThanOrEqual(8)
  expect(request!.y - button!.y - button!.height).toBeLessThanOrEqual(20)
})
