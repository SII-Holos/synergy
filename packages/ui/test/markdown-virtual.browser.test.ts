import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let directory: string
let server: ViteDevServer
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".markdown-virtual-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { Markdown } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown.tsx"))}
    import { MarkedProvider } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/context/marked.tsx"))}
    import { configureClipboard } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/clipboard-core.ts"))}
    import ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown.css"))}
    const code = "const original = '保持原文';\\n".repeat(2000)
    const [text,setText] = createSignal("$E=mc^2$\\n\\n" + Array.from({length:5000},(_,index)=>"paragraph " + index + " **bold**\\n\\n").join("") + "\\n\`\`\`ts\\n" + code + "\`\`\`")
    const copies: string[] = []
    configureClipboard({writer: value=>{ copies.push(value);return true }})
    const i18n = setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><MarkedProvider><div id="scroller" style="height:480px;overflow:auto;width:720px"><Markdown text={text()} /></div></MarkedProvider></I18nProvider>,document.getElementById("root")!)
    Object.assign(window,{markdownFixture:{setText,copies,code}})
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      // Vite maps port 0 to its default: https://github.com/vitejs/vite/blob/v7.1.4/packages/vite/src/node/server/index.ts
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, ".."), path.resolve(import.meta.dir, "../../../node_modules")] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => errors.push(error.message))
  const address = server.httpServer!.address() as { port: number }
  await page.goto(`http://127.0.0.1:${address.port}`)
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("real worker rendering bounds huge Markdown DOM and preserves full code and trusted math copying", async () => {
  await page.waitForSelector("[data-markdown-block]", { timeout: 20_000 })
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(await page.locator("p").count()).toBeLessThan(100)
  await page.locator('[data-katex-copy="true"]').first().click()
  expect(
    await page.evaluate(
      () => (window as unknown as { markdownFixture: { copies: string[] } }).markdownFixture.copies[0],
    ),
  ).toBe("E=mc^2")
  await page.locator("#scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForSelector('[data-slot="markdown-code-copy-text"]')
  await page.locator('[data-slot="markdown-code-header"] button').last().click()
  expect(
    await page.evaluate(() => {
      const fixture = (window as unknown as { markdownFixture: { copies: string[]; code: string } }).markdownFixture
      return fixture.copies.at(-1) === fixture.code.trimEnd()
    }),
  ).toBe(true)
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(errors).toEqual([])
}, 30_000)

test("a new Markdown version replaces the old worker document without stale blocks", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.evaluate(() =>
    (window as unknown as { markdownFixture: { setText(text: string): void } }).markdownFixture.setText(
      "New **version**",
    ),
  )
  await page.waitForFunction(
    () => document.querySelector('[data-component="markdown"]')?.textContent === "New version\n",
  )
  expect(await page.locator("[data-markdown-block]").count()).toBe(0)
  expect(errors).toEqual([])
})

test("the lazy worker loads a real TypeScript grammar for normal code", async () => {
  await page.evaluate(() =>
    (window as unknown as { markdownFixture: { setText(text: string): void } }).markdownFixture.setText(
      "```ts\nconst answer: number = 42\n```",
    ),
  )
  await page.waitForSelector("pre.shiki code span[style]")
  expect(await page.locator("pre.shiki code").textContent()).toContain("const answer: number = 42")
  expect(errors).toEqual([])
})
