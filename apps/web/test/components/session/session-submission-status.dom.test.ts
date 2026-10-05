import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, page: Page, directory: string, url: string
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")
const ui = path.resolve(app, "../../packages/ui/src")
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".submission-status-"))
  const locale = path.join(directory, "locale.ts")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      locale,
      `
      import { createSignal } from "solid-js"
      import { setupI18n } from "@lingui/core"
      import { createReactiveI18n } from ${JSON.stringify(`/@fs/${app}/src/context/locale/reactive-i18n.ts`)}
      export const core = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": {
        "session.activity.createWorktree": "正在准备工作区 · 创建 worktree",
        "session.activity.submittingInput": "正在提交消息",
      } } })
      const [generation, setGeneration] = createSignal(0)
      export const useLocale = () => ({ i18n: createReactiveI18n(core, generation) })
      export const activate = () => { core.activate("zh-CN"); setGeneration(n => n + 1) }
    `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { Suspense } from "solid-js"
      import { I18nProvider } from "@lingui/solid"
      import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme/context"
      import { SubmissionFixture } from ${JSON.stringify(`/@fs/${app}/test/fixtures/conversation/submission.tsx`)}
      import ${JSON.stringify(`/@fs/${ui}/components/error-card.css`)}
      import ${JSON.stringify(`/@fs/${ui}/components/collapsible.css`)}
      import ${JSON.stringify(`/@fs/${ui}/components/button.css`)}
      import { core, activate } from "./locale"
      render(() => <I18nProvider i18n={core}><ThemeProvider><Suspense><SubmissionFixture locale={activate} /></Suspense></ThemeProvider></I18nProvider>, document.querySelector("#root"))
    `,
    ),
  ])
  await Bun.write(
    path.join(directory, "execution.ts"),
    "export const useExecution=()=>({available:()=>false,round:()=>undefined,open:()=>{}})",
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: {
        "@/context/locale": locale,
        "@/context/execution": path.join(directory, "execution.ts"),
        "@": path.join(app, "src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(app, "../.."), directory] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 30000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("one current status replaces workspace progress and reacts to locale changes", async () => {
  await page.goto(url)
  await page.getByRole("status").waitFor()
  expect(await page.getByRole("status").textContent()).toContain("Preparing workspace · create worktree")
  expect(await page.locator('[data-component="user-message"] [data-slot="user-message-text"]').textContent()).toBe(
    "Inspect this project",
  )
  await page.evaluate("window.fixture.locale()")
  await page.getByText("正在准备工作区 · 创建 worktree", { exact: true }).waitFor()
  await page.evaluate("window.fixture.submitting()")
  await page.getByText("正在提交消息", { exact: true }).waitFor()
  expect(await page.getByRole("status").count()).toBe(1)
  expect(await page.locator('[data-component="error-card"]').count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

test.each(["message", "accepted-message"])(
  "message, attachment, status and viewport retain their nodes through admission as %s",
  async (canonicalID) => {
    await page.goto(`${url}?image`)
    await page.getByRole("status").waitFor()
    await page.locator("img").waitFor()
    await page.waitForFunction(() => !document.querySelector("[data-message-arrival]"), { timeout: 3000 })
    await page.evaluate(() => {
      ;(window as unknown as { nodes: Array<Element | null> }).nodes = [
        document.querySelector('[data-component="user-message"]'),
        document.querySelector("img"),
        document.querySelector('[data-slot="turn-process-trigger"]'),
        document.querySelector("[role=status]"),
        document.querySelector("[data-test-scroller]"),
      ]
    })
    for (const action of ["handoff", "canonical", "evict", "waiting", "lateReceipt"]) {
      await page.evaluate(
        ({ action, id }) =>
          (window as unknown as { fixture: Record<string, (id: string) => void> }).fixture[action](id),
        { action, id: canonicalID },
      )
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      if (action === "evict") {
        expect(
          await page.locator('[data-row-kind="load"]').evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(0)
        await page.waitForFunction(
          () => (window as unknown as { fixture: { contentLoads(): number } }).fixture.contentLoads() === 1,
        )
      }
      expect({
        action,
        nodes: await page.evaluate(() =>
          (window as unknown as { nodes: Array<Element | null> }).nodes.map((node) => node?.isConnected),
        ),
      }).toEqual({ action, nodes: [true, true, true, true, true] })
      expect(await page.getByRole("status").count()).toBe(1)
      expect(await page.getByText("Inspect this project", { exact: true }).count()).toBe(1)
      expect(await page.locator("img").count()).toBe(1)
    }
    expect(await page.getByRole("status").textContent()).toContain("Waiting for model response")
    expect(await page.locator("[data-message-arrival]").count()).toBe(0)
    expect(errors).toEqual([])
  },
  30000,
)

test("attachment and source disclosure survive admission under a different canonical identity", async () => {
  await page.goto(`${url}?image&many`)
  await page.getByRole("button", { name: "Expand all 8 attachments" }).click()
  await page.getByRole("button", { name: "View source", exact: true }).click()
  await page.evaluate("window.fixture.handoff()")
  await page.evaluate("window.fixture.canonical('accepted-message', true)")
  await page.getByRole("button", { name: "Collapse attachments" }).waitFor()
  expect(await page.getByRole("button", { name: "Markdown", exact: true }).getAttribute("aria-pressed")).toBe("true")
  for (const slot of ["time", "copy", "source"])
    expect(await page.locator(`[data-slot="user-message-${slot}"]`).count()).toBe(1)
  expect(await page.locator('[data-component="user-message"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)

test("storage readiness gates canonical history while retaining the captured attachment and message", async () => {
  await page.goto(`${url}?image&preparing`)
  await page.getByRole("status").waitFor()
  await page.locator("img").waitFor()
  const message = await page.locator('[data-component="user-message"]').elementHandle()
  await page.evaluate("window.fixture.history(); window.fixture.handoff()")
  expect(await page.getByText("Unchecked history", { exact: true }).count()).toBe(0)
  expect(await page.locator('[data-slot="user-message-time"]').count()).toBe(1)
  expect(await page.getByText("Inspect this project", { exact: true }).count()).toBe(1)
  expect(await page.locator("img").count()).toBe(1)
  await page.evaluate("window.fixture.ready()")
  await page.getByText("Unchecked history", { exact: true }).waitFor()
  expect(await message!.evaluate((node) => node.isConnected)).toBe(true)
  expect(await page.locator("img").count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)

test("shared error cards retain diagnostics and expose keyboard retry with details collapsed in both themes", async () => {
  await page.goto(url)
  await page.getByRole("status").waitFor()
  await page.evaluate("window.fixture.fail()")
  const header = page.getByRole("button", { name: "Unable to start execution" })
  await header.waitFor()
  expect(await page.getByRole("status").count()).toBe(0)
  expect(await header.getAttribute("aria-expanded")).toBe("false")
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => (window as unknown as { fixture: { theme(mode: string): void } }).fixture.theme(mode),
      mode,
    )
    const retry = page.getByRole("button", { name: "Retry", exact: true })
    expect(await retry.isVisible()).toBe(true)
    await retry.focus()
    await retry.press("Enter")
  }
  expect(await page.evaluate<number>("window.fixture.retries()")).toBe(2)
  expect(await page.getByText("Inspect this project", { exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await header.press("Enter")
  await page.getByText("InputMaterializationError: Execution configuration unavailable", { exact: true }).waitFor()
  expect(await header.getAttribute("aria-expanded")).toBe("true")
  expect(await page.locator('[data-component="error-card"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)
