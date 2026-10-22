import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

const source = path.resolve(import.meta.dir, "../../../src")
let directory: string
let server: BrowserFixture
let browser: Browser
let context: BrowserContext
let page: Page
const errors: string[] = []

const fixture = String.raw`
import { render } from "solid-js/web"
import { For, createSignal } from "solid-js"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import { ConversationViewport } from "@/components/session/conversation-viewport"
import "@ericsanchezok/synergy-ui/styles"
import "@/index.css"

const i18n = setupI18n({ locale: "zh-CN", messages: { "zh-CN": { "app.session.loading": "正在加载对话…" } } })
const [ready, setReady] = createSignal(true)
const [turn, setTurn] = createSignal("A")
const turns = {
  A: [
    "先确认这个位置的滚动行为：切换会话时内容区会被整体替换，阅读位置靠底部锚点维持。",
    "所以任何一次重排都会被读成跳动，等待态也需要落在同一个位置。",
    "我把等待态的形状对齐成内容列本身的形状，这样眼睛不需要换焦点。",
  ],
  B: [
    "等待态现在和正文共用同一列几何：同左边界、同列宽、同阅读位。",
    "行宽按段落节奏给出长短变化，最后一行留短，读起来是一段话而不是一排格子。",
    "到达时是在同一位置淡入，没有从中心向外展开的过程。",
  ],
}
const autoScroll = createAutoScroll({ working: () => false })

window.fixture = {
  load() {
    setReady(false)
    setTimeout(() => {
      setTurn("B")
      setReady(true)
    }, 900)
  },
}

render(
  () => (
    <I18nProvider i18n={i18n}>
      <div style={{ height: "100dvh", display: "flex", "flex-direction": "column" }}>
        <div class="session-workbench-pane" style={{ position: "relative", flex: "1", "min-height": "0" }}>
          <ConversationViewport
            ready={ready()}
            scrolledUp={false}
            onScrolledUpChange={() => {}}
            autoScroll={autoScroll}
            setScrollRef={autoScroll.scrollRef}
            contentClass="session-conversation-content session-content-column flex flex-col items-start justify-start gap-5"
            contentClassList={{ "pb-6 md:pb-[calc(var(--prompt-height,10rem)+32px)]": true }}
          >
            <For each={turns[turn()]}>
              {(paragraph) => (
                <p style={{ margin: "0" }}>{paragraph}</p>
              )}
            </For>
          </ConversationViewport>
        </div>
      </div>
    </I18nProvider>
  ),
  document.querySelector("#root"),
)
`

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".loading-placeholder-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(path.join(directory, "main.tsx"), fixture)
  server = await createBrowserFixture({ root: directory, styled: true, aliases: [{ find: "@", replacement: source }] })
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: path.join(directory, "video"), size: { width: 1280, height: 800 } },
  })
  page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 180_000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60_000)

const boxes = () =>
  page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
        top: box.top,
        bottom: box.bottom,
      }
    }
    const placeholder = document.querySelector("[data-conversation-loading]")
    const lines = [...document.querySelectorAll("[data-conversation-loading-line]")]
    const label = document.querySelector("[data-conversation-loading] [role=status]")
    const paragraphs = [...document.querySelectorAll("[data-conversation-viewport] p")]
    return {
      viewport: rect(document.querySelector("[data-conversation-viewport]")),
      placeholderColumn: rect(placeholder?.querySelector(".session-content-column") ?? null),
      contentColumn: rect(document.querySelector("[data-conversation-viewport] > .session-content-column")),
      lines: lines.map(rect),
      firstParagraph: paragraphs.length ? rect(paragraphs[0]!) : null,
      lineText: lines.map((line) => line.textContent ?? ""),
      placeholderText: placeholder?.textContent ?? "",
      placeholderAnimation: lines[0]?.getAnimations().length ?? 0,
      label: rect(label),
      labelText: label?.textContent ?? "",
    }
  })

test("the waiting state occupies the conversation column instead of a centred indicator", async () => {
  await page.goto(server.url)
  await page.getByText("先确认这个位置的滚动行为", { exact: false }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { load(): void } }).fixture.load())
  await page.locator("[data-conversation-loading]").waitFor()
  const waiting = await boxes()

  // Same column as the transcript it will be replaced by: this is the whole point.
  expect(waiting.placeholderColumn).not.toBeNull()
  expect(waiting.contentColumn).not.toBeNull()
  expect(Math.abs(waiting.placeholderColumn!.left - waiting.contentColumn!.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(waiting.placeholderColumn!.width - waiting.contentColumn!.width)).toBeLessThanOrEqual(1)

  // Prose-shaped, and carrying no body text at all.
  expect(waiting.lines.length).toBeGreaterThan(1)
  expect(new Set(waiting.lineText)).toEqual(new Set([""]))
  expect(waiting.placeholderText).not.toContain("先确认")

  // The status line stays available to assistive technology without painting a
  // label into the transcript column.
  expect(waiting.labelText).toBe("正在加载对话…")
  expect(waiting.label!.width).toBeLessThanOrEqual(1)
  expect(waiting.label!.height).toBeLessThanOrEqual(1)

  // Runs past the pane's bottom edge, so the shape also covers the column when
  // long history resumes at its latest turn. Anchoring only to that edge would
  // leave short history — which starts at the column top — uncovered.
  expect(waiting.lines.at(-1)!.bottom).toBeGreaterThan(waiting.viewport!.bottom)

  await page.locator("[data-conversation-loading]").waitFor({ state: "detached" })
  await page.getByText("等待态现在和正文共用同一列几何", { exact: false }).waitFor()

  // The invariant that matters: the shape starts where the transcript starts, so
  // the reveal does not move it. A centred or bottom-anchored indicator fails
  // this against short history, which is laid out from the column top.
  const admitted = await boxes()
  expect(admitted.firstParagraph).not.toBeNull()
  const waitingCentre = (waiting.lines[0]!.top + waiting.lines[0]!.bottom) / 2
  const textCentre = (admitted.firstParagraph!.top + admitted.firstParagraph!.bottom) / 2
  expect(Math.abs(waitingCentre - textCentre)).toBeLessThanOrEqual(3)

  expect(errors).toEqual([])
})

test("the waiting shape stays still under reduced motion", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(server.url)
  await page.getByText("先确认这个位置的滚动行为", { exact: false }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { load(): void } }).fixture.load())
  await page.locator("[data-conversation-loading]").waitFor()
  expect((await boxes()).placeholderAnimation).toBe(0)
  await page.emulateMedia({ reducedMotion: "no-preference" })
})
