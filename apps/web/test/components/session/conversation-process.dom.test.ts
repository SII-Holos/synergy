import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

type Fixture = {
  prepare(): void
  stream(): void
  terminal(): void
  complete(): void
  grow(count: number): void
  reading(value: boolean): void
  retained(): number
  mode(value: "full" | "balanced" | "minimal"): void
  contentRecover(id: string): void
  contentPending(id: string): void
  contentFinish(id: string): void
  contentReads(id: string): number
  contentReconnect(): void
}
declare global {
  interface Window {
    __conversationProcess: Fixture
    answerNode?: Element | null
  }
}
let server: ViteDevServer, browser: Browser, page: Page, directory: string, url: string
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")
const frames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
const contentPage = async (scenario: string) => {
  await page.close()
  page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${url}?content=${scenario}`)
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".conversation-process-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<style>body{font:16px/24px system-ui}button{font:inherit}[data-component="session-turn"]{height:auto}[data-slot="session-turn-content"]{height:auto!important}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import ${JSON.stringify(`/@fs/${app}/test/fixtures/conversation/process.tsx`)}`,
  )
  await Bun.write(
    path.join(directory, "execution.ts"),
    "export const useExecution=()=>({available:()=>true,round:()=>undefined,open:()=>{}})",
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: { alias: [{ find: "@/context/execution", replacement: path.join(directory, "execution.ts") }] },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(app, "../.."), directory] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error(e.stack)
  })
  await page.goto(url, { timeout: 60000 })
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
}, 90000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 30000)

test("logical execution folds across messages, preserves prose and retains the final Markdown through exit", async () => {
  await page.goto(url)
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
    })
  expect(await page.locator('[data-row-kind="activity"]').count()).toBe(2)
  expect(await page.locator('[data-slot="activity-batch-trigger"][aria-expanded="true"]').count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.stream())
  await frames()
  await page.locator("[data-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page
    .getByText("Final answer stays mounted.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(await page.locator("#root").innerHTML(), { cause: error })
    })
  await page.evaluate(() => {
    window.answerNode = document.querySelector('[data-part-id="answer"] [data-component="markdown"]')
    window.__conversationProcess.terminal()
  })
  await frames()
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.complete())
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  expect(
    await page.evaluate(
      () =>
        !!window.answerNode &&
        window.answerNode === document.querySelector('[data-part-id="answer"] [data-component="markdown"]'),
    ),
  ).toBe(true)
  await page.locator('[data-slot="turn-process-trigger"]').click()
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  expect(await page.locator('[data-slot="activity-batch-trigger"][aria-expanded="true"]').count()).toBe(0)
  await page.locator('[data-slot="activity-batch-trigger"]').last().click()
  await page.locator('[data-slot="activity-step"]').nth(1).waitFor()
  expect(errors).toEqual([])
}, 60000)

test("detached reading holds the process and large blocks retain bounded mounted content", async () => {
  await page.goto(url)
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  await page.evaluate(() => {
    window.__conversationProcess.stream()
    window.__conversationProcess.reading(true)
    window.__conversationProcess.complete()
  })
  await frames()
  expect(await page.getByText("I will check the project first.", { exact: true }).count()).toBe(1)
  await page.evaluate(() => window.__conversationProcess.reading(false))
  await page.waitForFunction(() => !document.querySelector('[data-row-kind="activity"]'))
  await page.goto(url)
  await page
    .getByText("I will check the project first.", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  await page.evaluate(() => window.__conversationProcess.grow(1000))
  await frames()
  expect(await page.locator('[data-row-kind="activity"]').count()).toBe(2)
  expect(await page.evaluate(() => window.__conversationProcess.retained())).toBeLessThan(120)
  expect(errors).toEqual([])
}, 60000)

test("preparing a turn shows thinking without a premature Details-only footer", async () => {
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.prepare())
  await frames()
  expect(await page.locator('[data-slot="turn-process-trigger"]').textContent()).toContain("Synergy is thinking")
  expect(await page.locator('[data-component="execution-completion"]').count()).toBe(0)
  expect(await page.locator('[data-kind="copy-markdown"]').count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

test("focusing a closed activity header preserves its state until the first explicit activation", async () => {
  await page.goto(url)
  const trigger = page.locator('[data-slot="activity-batch-trigger"]').first()
  await trigger.waitFor()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.focus()
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.press("Enter")
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  await trigger.click()
  await frames()
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
}, 30000)

test("SDK conflicts recover in real conversation rows across activity modes without altering literal message text", async () => {
  for (const mode of ["full", "balanced", "minimal"] as const) {
    await contentPage("conflict")
    await page
      .getByText("I will check the project first.", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
      })
    await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 2)
    await page.evaluate((mode) => window.__conversationProcess.mode(mode), mode)
    await frames()
    expect(await page.locator("[data-content-error]").count()).toBe(0)
    expect(await page.getByText("Literal message: [object Object]", { exact: true }).count()).toBe(1)
  }
  expect(errors).toEqual([])
}, 60000)

test("each part clears only its own failure and keeps the existing Markdown mounted", async () => {
  await contentPage("mixed")
  await page
    .getByText("Content unavailable: progress", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ url: page.url(), errors, html: await page.content() }), { cause: error })
    })
  await page.evaluate(() => {
    window.answerNode = document.querySelector('[data-part-id="progress"] [data-component="markdown"]')
    window.__conversationProcess.contentRecover("progress")
  })
  await page.getByText("Content unavailable: progress-2", { exact: true }).waitFor()
  expect(await page.getByText("Content unavailable: progress", { exact: true }).count()).toBe(0)
  expect(
    await page.evaluate(
      () => window.answerNode === document.querySelector('[data-part-id="progress"] [data-component="markdown"]'),
    ),
  ).toBe(true)
  await page.evaluate(() => window.__conversationProcess.contentRecover("progress-2"))
  await page.waitForFunction(() => !document.querySelector("[data-content-error]"))
  expect(errors).toEqual([])
}, 60000)

test("manual retry is keyboard accessible, disables duplicate requests and clears the recovered error", async () => {
  await contentPage("mixed")
  await page.getByText("Content unavailable: progress", { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationProcess.contentRecover("progress-2")
    window.__conversationProcess.contentPending("progress")
  })
  const retry = page.getByRole("button", { name: "Retry loading content", exact: true })
  await retry.focus()
  await retry.press("Enter")
  const pending = page.getByRole("button", { name: "Retrying…", exact: true })
  await pending.waitFor()
  expect(await pending.isDisabled()).toBe(true)
  await pending.evaluate((button) => (button as HTMLButtonElement).click())
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(2)
  await page.evaluate(() => window.__conversationProcess.contentFinish("progress"))
  await page.waitForFunction(() => !document.querySelector("[data-content-error]"))
  expect(errors).toEqual([])
}, 60000)

test("exhausted conflicts show a sync retry and malformed errors use a readable fallback", async () => {
  await contentPage("stalled")
  await page.getByText("Couldn’t sync this content", { exact: true }).waitFor()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(8)
  await frames()
  expect(await page.evaluate(() => window.__conversationProcess.contentReads("progress"))).toBe(8)
  await contentPage("malformed")
  await page.getByText("Couldn’t load this content", { exact: true }).waitFor()
  expect(await page.locator("[data-content-error]").innerText()).not.toContain("[object Object]")
  expect(await page.getByRole("button", { name: "Retry loading content", exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
}, 60000)

test("reconnect renews invalidated body leases even when the summary version stays the same", async () => {
  await contentPage("conflict")
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 2)
  await page.evaluate(() => window.__conversationProcess.contentReconnect())
  await page.waitForFunction(() => window.__conversationProcess.contentReads("progress") === 3)
  expect(await page.locator("[data-content-error]").count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)
