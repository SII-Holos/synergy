import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, preview, type PreviewServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: PreviewServer
let fixture: string
const errors: string[] = []
const github =
  "https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/compaction/compaction-basic/src/index.ts#L289-L327"

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".resource-preview-"))
  const source = path.resolve(import.meta.dir, "../../src")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { Markdown, UserMarkdown } from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../fixtures/session-turn/markdown-resources.tsx")}`)}
    import { MarkedProvider } from ${JSON.stringify(`/@fs/${source}/context/marked.tsx`)}
    import { ResourceOpenProvider } from ${JSON.stringify(`/@fs/${source}/context/resource-open.tsx`)}
    import { ViewActivityProvider } from ${JSON.stringify(`/@fs/${source}/context/view-activity.tsx`)}
    import { configureClipboard } from ${JSON.stringify(`/@fs/${source}/components/clipboard-core.ts`)}
    import ${JSON.stringify(`/@fs/${source}/styles/index.css`)}
    const [streaming, setStreaming] = createSignal(false)
    const [active, setActive] = createSignal(true)
    const [contextKey, setContextKey] = createSignal("initial")
    const [multiple, setMultiple] = createSignal(false)
    const [text, setText] = createSignal(${JSON.stringify(`${github}，理论上来讲后文。 [Original label](https://example.org/second) [Note](note://nte_example#stable-block)`)} )
    window.previews = []; window.opens = []; window.copies = []; window.aborted = 0; window.hold = false
    window.finish = () => setStreaming(false)
    window.start = () => setStreaming(true)
    window.setActive = setActive
    window.setText = setText
    window.setContextKey = setContextKey
    window.setMultiple = setMultiple
    configureClipboard({ writer: value => { window.copies.push(value); return true } })
    const resources = {
      contextKey,
      resolveUrl: () => "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      openLabel: () => "Open in workspace",
      open: async (resource, options) => { window.opens.push({resource, options: {prefer: options?.prefer, newTab: options?.newTab}}); return {status:"opened"} },
      preview: async (resource, options) => {
        window.previews.push(resource)
        options?.signal?.addEventListener("abort", () => window.aborted++)
        if(window.hold) await new Promise(resolve => window.release = resolve)
        if(window.emptyPreview) return {title:"Archive.zip",source:"File",unavailable:"Preview unavailable"}
        if(resource.kind === "asset") return {title:resource.filename,source:"Image",image:{src:window.brokenImage ? "/missing.png" : resources.resolveUrl(),alt:resource.filename}}
        return {title: resource.kind === "note" ? "Note title" : resource.url, source:"example.org", path: resource.kind === "note" ? "note://" + resource.id + "#" + resource.location.id : undefined, description:"A readable preview", code:{text:window.longCode ? "long_source_identifier_".repeat(200) : "const value = 1",language:"ts",startLine:289}, meta:"fixed commit"}
      }
    }
    const i18n = setupI18n({ locale:"en",messages:{en:{}} })
    render(() => <I18nProvider i18n={i18n}><ViewActivityProvider active={active}><ResourceOpenProvider value={resources}><MarkedProvider><div style="width: min(650px, 100%); overflow:hidden; padding:16px"><div data-preview-message="assistant"><Markdown text={text()} streaming={streaming()} /></div><Show when={multiple()}><div data-preview-message="user" style="margin-left:380px; margin-top:96px"><UserMarkdown text="[User reference](https://example.net/user)" /></div><div data-preview-message="assistant-next" style="margin-left:380px; margin-top:96px"><Markdown text="[Next assistant reference](https://example.net/other)" /></div></Show></div></MarkedProvider></ResourceOpenProvider></ViewActivityProvider><button id="after">After references</button></I18nProvider>, document.getElementById("root"))
  `,
  )
  await build({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin()],
    cacheDir: path.join(fixture, ".vite"),
    logLevel: "silent",
    build: { outDir: path.join(fixture, "dist"), emptyOutDir: true },
    worker: { format: "es" },
  })
  server = await preview({
    configFile: false,
    root: fixture,
    logLevel: "silent",
    build: { outDir: path.join(fixture, "dist") },
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
}, 120000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator('a[data-resource-bound][target="_blank"]').first().waitFor()
})
afterEach(async () => {
  await page?.close()
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve()
    server.httpServer.close((error) => (error ? reject(error) : resolve()))
  })
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("intent waits 400ms without reads, keeps native href and renders an interactive unclipped preview", async () => {
  const link = page.locator("a[data-resource-bound]").first()
  expect(await page.evaluate(() => (window as unknown as { previews: unknown[] }).previews.length)).toBe(0)
  expect(await link.getAttribute("href")).toBe(github)
  expect(await link.getAttribute("data-resource-label")).toBe("deepseek-harness / index.ts:289–327")
  expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("none")
  expect(await link.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
  const now = Date.now()
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  await link.hover()
  await page.clock.runFor(399)
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  await page.clock.runFor(1)
  await page.locator('[data-component="resource-preview"]').waitFor()
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens.length)).toBe(0)
  await page.locator('[data-component="resource-preview"]').hover()
  await page.clock.runFor(200)
  expect(await page.locator('[data-component="resource-preview"]').isVisible()).toBe(true)
  expect(
    await page
      .locator('[data-component="resource-preview"]')
      .evaluate((element) => !element.closest('[data-component="markdown"]')),
  ).toBe(true)
  await page.getByRole("button", { name: "Copy link", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { copies: string[] }).copies)).toEqual([github])
  await page.getByRole("button", { name: "Open in system browser", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens)).toMatchObject([
    { resource: { kind: "url", url: github }, options: { prefer: "external" } },
  ])
  expect(errors).toEqual([])
})

test("keyboard opens directly, tabs into actions, escapes to source and never traps focus", async () => {
  const link = page.locator("a[data-resource-bound]").first()
  await link.focus()
  await page.locator('[data-component="resource-preview"]').waitFor()
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await page.locator('[data-component="resource-preview"]').waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.matches("a[data-resource-bound]"))
  expect(await link.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens.length)).toBe(1)
  await page.locator("#after").focus()
  expect(await page.locator("#after").evaluate((element) => element === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
})

for (const crossing of [
  { from: "assistant", to: "user", target: "https://example.net/user" },
  { from: "user", to: "assistant-next", target: "https://example.net/other" },
  { from: "assistant", to: "assistant-next", target: "https://example.net/other" },
]) {
  test(`${crossing.from} focus and ${crossing.to} pointer share one preview and discard the prior message response`, async () => {
    await page.evaluate(() => (window as unknown as { setMultiple(value: boolean): void }).setMultiple(true))
    const source = page
      .locator(
        `[data-preview-message="${crossing.from}"] a[data-resource-bound]${crossing.from === "user" ? "" : '[target="_blank"]'}`,
      )
      .first()
    const target = page
      .locator(
        `[data-preview-message="${crossing.to}"] a[data-resource-bound]${crossing.to === "user" ? "" : '[target="_blank"]'}`,
      )
      .first()
    await target.waitFor()
    await page.locator(`[data-preview-message="${crossing.to}"]`).evaluate((message, from) => {
      ;(message as HTMLElement).style.marginLeft = from === "user" ? "0px" : "380px"
    }, crossing.from)
    const now = Date.now()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    await page.evaluate(() => Object.assign(window, { hold: true }))
    await source.focus()
    await page.clock.runFor(400)
    await page.waitForFunction(() => (window as unknown as { previews: unknown[] }).previews.length === 1)
    await page.evaluate(() => Object.assign(window, { hold: false }))
    await target.hover()
    expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
    expect(await source.getAttribute("data-resource-preview")).toBeNull()
    expect(await page.evaluate(() => (window as unknown as { aborted: number }).aborted)).toBe(1)
    await page.clock.runFor(400)
    await page.waitForFunction(() => (window as unknown as { previews: unknown[] }).previews.length === 2)
    await page.clock.runFor(1000)
    expect(await page.locator('[data-component="resource-preview"]').count()).toBe(1)
    expect(await page.locator('[data-component="popover-content"]').count()).toBe(1)
    expect(await source.getAttribute("data-resource-preview")).toBeNull()
    expect(await target.getAttribute("data-resource-preview")).toBe("true")
    expect(await page.evaluate(() => (window as unknown as { aborted: number }).aborted)).toBe(1)
    await page.evaluate(() => (window as unknown as { release(): void }).release())
    await page.clock.runFor(1000)
    const card = page.locator('[data-component="resource-preview"]')
    expect(await card.count()).toBe(1)
    expect(await card.getByRole("heading").textContent()).toBe(crossing.target)
    await card.getByRole("button", { name: "Copy link", exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as { copies: string[] }).copies.at(-1))).toBe(crossing.target)
    await card.getByRole("button", { name: "Close preview", exact: true }).focus()
    await page.keyboard.press("Escape")
    await page.clock.runFor(1000)
    expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
    expect(await target.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press("Enter")
    expect(
      await page.evaluate(
        () => (window as unknown as { opens: { resource: { url: string } }[] }).opens.at(-1)?.resource.url,
      ),
    ).toBe(crossing.target)
    await page.locator("#after").focus()
    expect(await page.locator("#after").evaluate((element) => element === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  })
}

test("a newer message intent cancels another component's pending preview before any body read", async () => {
  await page.evaluate(() => (window as unknown as { setMultiple(value: boolean): void }).setMultiple(true))
  const source = page.locator('[data-preview-message="assistant"] a[data-resource-bound][target="_blank"]').first()
  const target = page.locator('[data-preview-message="user"] a[data-resource-bound]').first()
  await target.waitFor()
  const now = Date.now()
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  await source.focus()
  await page.clock.runFor(200)
  await target.hover()
  await page.clock.runFor(399)
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { previews: unknown[] }).previews)).toEqual([])
  await page.clock.runFor(1)
  await page.waitForFunction(() => (window as unknown as { previews: unknown[] }).previews.length === 1)
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(1)
  expect(await page.locator('[data-component="resource-preview"] h3').textContent()).toBe("https://example.net/user")
  await page.clock.runFor(1000)
  expect(await source.getAttribute("data-resource-preview")).toBeNull()
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(1)
  expect(errors).toEqual([])
})

test("recycling the active message releases its preview work without reviving a previous message", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { setMultiple(value: boolean): void }).setMultiple(true)
    Object.assign(window, { hold: true })
  })
  await page.locator('[data-preview-message="user"] a[data-resource-bound]').hover()
  await page.locator('[data-component="resource-preview"]').waitFor()
  await page.evaluate(() => (window as unknown as { setMultiple(value: boolean): void }).setMultiple(false))
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { aborted: number }).aborted)).toBe(1)
  await page.evaluate(() => {
    ;(window as unknown as { release(): void }).release()
    Object.assign(window, { hold: false })
  })
  const source = page.locator('[data-preview-message="assistant"] a[data-resource-bound]').first()
  await source.focus()
  await page.locator('[data-component="resource-preview"]').waitFor()
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(1)
  expect(await page.locator('[data-component="resource-preview"] h3').textContent()).toBe(github)
  expect(errors).toEqual([])
})

test("stream settlement does not duplicate icons or replace selected original URL text", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.evaluate(() => (window as unknown as { start(): void }).start())
  const link = page.locator("a[data-resource-bound]").first()
  await link.waitFor()
  await link.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element.querySelector("[data-reference-text]") ?? element)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(github)
  const original = await link.elementHandle()
  await page.keyboard.press("ControlOrMeta+c")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(github)
  await page.evaluate(() => (window as unknown as { finish(): void }).finish())
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(github)
  expect(await link.evaluate((element, original) => element === original, original)).toBe(true)
  await page.keyboard.press("ControlOrMeta+c")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(github)
  await page.evaluate(() => {
    getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
  })
  await page.waitForTimeout(100)
  expect(await page.locator("a[data-resource-bound]").first().locator("[data-reference-icon]").count()).toBe(1)
  expect(errors).toEqual([])
})

test("Note preview shows content without internal addresses and retains copy and destination actions", async () => {
  await page.locator('a[data-resource-kind="note"]').hover()
  const card = page.locator('[data-component="resource-preview"]')
  await card.getByRole("heading", { name: "Note title", exact: true }).waitFor()
  expect(await card.locator('[data-slot="resource-preview-path"]').count()).toBe(0)
  expect(await card.textContent()).not.toContain("note://")
  await card.getByRole("button", { name: "Copy link", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { copies: string[] }).copies)).toEqual([
    "note://nte_example#stable-block",
  ])
  expect(await card.getByRole("button", { name: "Open in workspace", exact: true }).isVisible()).toBe(true)
  expect(errors).toEqual([])
})

for (const wrapped of [false, true]) {
  test(`body images ${wrapped ? "inside an explicit link" : "on their own"} open directly without a hover or focus preview`, async () => {
    await page.evaluate((wrapped) => {
      const image = "![Keyboard sequence](asset://0123456789abcdef.png)"
      ;(window as unknown as { setText(text: string): void }).setText(
        wrapped ? `[${image}](asset://0123456789abcdef.png)` : image,
      )
    }, wrapped)
    const link = page.locator("a[data-resource-bound]").first()
    await link.locator("img").waitFor()
    await link.hover()
    await page.waitForTimeout(500)
    await link.focus()
    await page.waitForTimeout(500)
    expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { previews: unknown[] }).previews)).toEqual([])
    expect(await link.getAttribute("title")).toBeNull()
    await link.click()
    expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens)).toMatchObject([
      { resource: { kind: "asset", filename: "Keyboard sequence" }, options: { prefer: "preview" } },
    ])
    expect(errors).toEqual([])
  })
}

test("image text references show their thumbnail and authored name while copying the original target", async () => {
  await page.evaluate(() =>
    (window as unknown as { setText(text: string): void }).setText("[Keyboard sequence](asset://0123456789abcdef.png)"),
  )
  await page.locator("a[data-resource-bound]").first().hover()
  const card = page.locator('[data-component="resource-preview"]')
  await card.getByRole("img", { name: "Keyboard sequence" }).waitFor()
  expect(await card.getByRole("heading").textContent()).toBe("Keyboard sequence")
  expect(await card.textContent()).not.toContain("asset://")
  await card.getByRole("button", { name: "Copy link", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { copies: string[] }).copies)).toEqual([
    "asset://0123456789abcdef.png",
  ])
  expect(errors).toEqual([])
})

test("unavailable content leaves no passive card but remains explicitly accessible", async () => {
  await page.close()
  page = await browser.newPage({ viewport: { width: 375, height: 650 }, isMobile: true, hasTouch: true })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator("a[data-resource-bound]").first().waitFor()
  await page.evaluate(() => Object.assign(window, { emptyPreview: true }))
  const link = page.locator("a[data-resource-bound]").first()
  await link.hover()
  await page.waitForFunction(() => (window as unknown as { previews: unknown[] }).previews.length === 1)
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  await link.locator("+ button[data-resource-info]").tap()
  const card = page.locator('[data-component="resource-preview"]')
  await card.getByText("Preview unavailable", { exact: true }).waitFor()
  expect(await card.getByRole("button", { name: "Open in workspace", exact: true }).isVisible()).toBe(true)
  await card.getByRole("button", { name: "Close preview", exact: true }).click()
  await link.click()
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens.length)).toBe(1)
})

test("keyboard focus inside the card keeps it open when the pointer leaves", async () => {
  await page.locator("a[data-resource-bound]").first().hover()
  const card = page.locator('[data-component="resource-preview"]')
  await card.locator("pre").focus()
  await page.mouse.move(850, 650)
  await page.waitForTimeout(200)
  expect(await card.isVisible()).toBe(true)
  expect(await card.locator('[data-slot="resource-preview-line-number"]').textContent()).toBe("289")
  await page.keyboard.press("Escape")
  await card.waitFor({ state: "detached" })
})

test("a failed image thumbnail dismisses a passive preview", async () => {
  await page.evaluate(() => {
    Object.assign(window, { brokenImage: true })
    ;(window as unknown as { setText(text: string): void }).setText("[Missing image](asset://0123456789abcdef.png)")
  })
  await page.locator("a[data-resource-bound]").first().hover()
  await page.waitForFunction(() => (window as unknown as { previews: unknown[] }).previews.length === 1)
  await page.locator('[data-component="resource-preview"]').waitFor({ state: "detached" })
  expect(errors).toEqual([])
})

test("hidden owners abort preview and ignore a late response", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { hold: boolean }).hold = true
  })
  await page.locator("a[data-resource-bound]").first().hover()
  await page.locator('[data-component="resource-preview"]').waitFor()
  await page.evaluate(() => (window as unknown as { setActive(active: boolean): void }).setActive(false))
  await page.locator('[data-component="resource-preview"]').waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as { aborted: number }).aborted)).toBe(1)
  await page.evaluate(() => (window as unknown as { release(): void }).release())
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("controller identity changes cancel same-object preview and stale reply", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { hold: boolean }).hold = true
  })
  await page.locator("a[data-resource-bound]").first().hover()
  await page.locator('[data-component="resource-preview"]').waitFor()
  await page.evaluate(() =>
    (window as unknown as { setContextKey(key: string): void }).setContextKey("other-server-scope-session-capability"),
  )
  await page.locator('[data-component="resource-preview"]').waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as { aborted: number }).aborted)).toBe(1)
  await page.evaluate(() => (window as unknown as { release(): void }).release())
  expect(await page.locator('[data-component="resource-preview"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("long source previews keep their destination and footer actions visible without scrolling the whole card", async () => {
  await page.evaluate(() => Object.assign(window, { longCode: true }))
  await page.locator("a[data-resource-bound]").first().hover()
  await page.getByText("fixed commit", { exact: true }).waitFor()
  const bounds = await page.locator('[data-component="resource-preview"]').evaluate((card) => {
    const popup = card.closest<HTMLElement>('[data-component="popover-content"]')!
    const footer = card.querySelector("footer")!.getBoundingClientRect()
    const frame = popup.getBoundingClientRect()
    return {
      footer: footer.bottom,
      bottom: frame.bottom,
      height: frame.height,
      scroll: popup.scrollTop,
    }
  })
  expect(bounds.scroll).toBe(0)
  expect(bounds.footer).toBeLessThanOrEqual(bounds.bottom)
  expect(bounds.height).toBeLessThanOrEqual(560)
  await page.setViewportSize({ width: 375, height: 500 })
  await page.locator('[data-component="resource-preview"]').hover()
  const narrow = await page.locator('[data-component="resource-preview"]').evaluate((card) => {
    const frame = card.closest('[data-component="popover-content"]')!.getBoundingClientRect()
    return {
      footer: card.querySelector("footer")!.getBoundingClientRect().bottom,
      bottom: frame.bottom,
      right: frame.right,
      width: innerWidth,
      height: innerHeight,
    }
  })
  expect(narrow.footer).toBeLessThanOrEqual(narrow.bottom)
  expect(narrow.right).toBeLessThanOrEqual(narrow.width)
  expect(narrow.bottom).toBeLessThanOrEqual(narrow.height)
})

test("touch has an explicit information action, bounded portal and a direct link", async () => {
  await page.close()
  page = await browser.newPage({ viewport: { width: 375, height: 650 }, isMobile: true, hasTouch: true })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator('a[data-resource-bound][target="_blank"]').first().waitFor()
  const info = page.getByRole("button", { name: "Preview reference", exact: true }).first()
  expect(await info.isVisible()).toBe(true)
  const box = await info.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(43.99)
  expect(box!.height).toBeGreaterThanOrEqual(43.99)
  await info.tap()
  await page.locator('[data-component="resource-preview"]').waitFor()
  const popup = await page.locator('[data-component="popover-content"]').boundingBox()
  expect(popup!.x).toBeGreaterThanOrEqual(0)
  expect(popup!.x + popup!.width).toBeLessThanOrEqual(375)
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens.length)).toBe(0)
  await page.getByRole("button", { name: "Close preview", exact: true }).tap()
  await page.locator("a[data-resource-bound]").first().tap()
  expect(await page.evaluate(() => (window as unknown as { opens: unknown[] }).opens.length)).toBe(1)
  expect(errors).toEqual([])
})
