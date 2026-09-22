import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".tag-menu-fixture-"))
  const stub = path.join(directory, "icons.tsx")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(stub, "export const Icon = () => null; export const getSemanticIcon = value => value"),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { SessionTagMenu } from ${JSON.stringify(`/@fs/${source}/components/session/session-tag-menu.tsx`)}
      import { Popover } from "@ericsanchezok/synergy-ui/popover"
      const calls: string[][] = []
      let fail = true
      let release: (() => void) | undefined
      const core = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": {
        "session.tags.menu": "标签", "session.tags.filterOrCreate": "筛选或创建标签",
        "session.tags.saveFailed": "无法保存标签", "session.tags.create": "创建 #{tag}",
      } } })
      window.fixture = { calls, release: () => release?.(), locale: () => core.activate("zh-CN") }
      render(() => <I18nProvider i18n={core}>
        <Popover title="Session actions" triggerAs={props => <button {...props}>Actions</button>}>
          <SessionTagMenu tags={[]} availableTags={[]} onChange={async tags => {
            calls.push(tags)
            if (fail) { fail = false; throw new Error("offline") }
            await new Promise<void>(resolve => { release = resolve })
            return tags
          }} />
        </Popover>
      </I18nProvider>, document.querySelector("#root")!)
    `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        { find: "@ericsanchezok/synergy-ui/icon", replacement: stub },
        { find: "@ericsanchezok/synergy-ui/semantic-icon", replacement: stub },
        {
          find: "@ericsanchezok/synergy-ui/popover",
          replacement: path.resolve(source, "../../../packages/ui/src/components/popover.tsx"),
        },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("failed saves retain input; pending saves serialize edits; accepted tags survive delayed events", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Tags", exact: true }).click()
    const input = page.getByRole("textbox", { name: "Filter or create a tag" })
    await input.fill("##focus")
    await input.press("Enter")
    await page.getByRole("alert").waitFor()
    expect(await input.inputValue()).toBe("##focus")
    expect(await page.getByRole("alert").textContent()).toBe("Could not save tags")
    await input.press("Enter")
    await page.waitForFunction(() => document.querySelector("input")?.disabled)
    await page.evaluate(() => (window as unknown as { fixture: { release(): void } }).fixture.release())
    await page.getByRole("button", { name: "#focus", exact: true }).waitFor()
    await input.fill("next")
    await input.press("Enter")
    expect(await page.evaluate(() => (window as unknown as { fixture: { calls: string[][] } }).fixture.calls)).toEqual([
      ["focus"],
      ["focus"],
      ["focus", "next"],
    ])
    await page.evaluate(() => (window as unknown as { fixture: { release(): void } }).fixture.release())
    await page.getByRole("button", { name: "#next", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as { fixture: { locale(): void } }).fixture.locale())
    await page.getByRole("textbox", { name: "筛选或创建标签" }).waitFor()
    await page.keyboard.press("Escape")
    expect(await page.getByRole("textbox").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
}, 30_000)
