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
      import { I18nProvider } from "@lingui/solid"
      import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme/context"
      import { SessionSubmissionPreview } from ${JSON.stringify(`/@fs/${app}/src/components/session/session-submission-preview.tsx`)}
      import { createSessionTransitionState } from ${JSON.stringify(`/@fs/${app}/src/context/session-transition.tsx`)}
      import { createNewSessionTransitionProgress, createSessionTransitionHandoffErrorProgress } from ${JSON.stringify(`/@fs/${app}/src/components/session/session-transition-progress.ts`)}
      import { createNewSessionWorkspaceProgress } from ${JSON.stringify(`/@fs/${app}/src/components/session/worktree-session.ts`)}
      import ${JSON.stringify(`/@fs/${ui}/components/error-card.css`)}
      import ${JSON.stringify(`/@fs/${ui}/components/collapsible.css`)}
      import ${JSON.stringify(`/@fs/${ui}/components/button.css`)}
      import { core, activate } from "./locale"
      function Fixture() {
        const theme = useTheme()
        const state = createSessionTransitionState()
        const lease = state.prepareDraft("draft")
        lease.submit({ text: "Inspect this project", messageID: "message", prompt: [{type:"text",content:"Inspect this project",start:0,end:20}] })
        lease.progress(createNewSessionWorkspaceProgress({selection:{mode:"create"},stage:"workspace"}))
        window.retries = 0
        window.fixture = {
          locale: activate,
          theme: mode => theme.setColorScheme(mode),
          submitting: () => lease.progress(createNewSessionTransitionProgress()),
          fail: () => lease.progress(createSessionTransitionHandoffErrorProgress({kind:"new-session",error:{code:"InputMaterializationError",message:"Execution configuration unavailable"}}),{retry:()=>window.retries++}),
        }
        return <SessionSubmissionPreview entry={state.get("draft")} />
      }
      render(() => <I18nProvider i18n={core}><ThemeProvider><Fixture /></ThemeProvider></I18nProvider>, document.querySelector("#root"))
    `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: { alias: { "@/context/locale": locale, "@": path.join(app, "src") } },
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
  expect(await page.locator(".session-submission-prompt").textContent()).toBe("Inspect this project")
  await page.evaluate("window.fixture.locale()")
  await page.getByText("正在准备工作区 · 创建 worktree", { exact: true }).waitFor()
  await page.evaluate("window.fixture.submitting()")
  await page.getByText("正在提交消息", { exact: true }).waitFor()
  expect(await page.getByRole("status").count()).toBe(1)
  expect(await page.locator('[data-component="error-card"]').count()).toBe(0)
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
  expect(await page.evaluate<number>("window.retries")).toBe(2)
  await header.press("Enter")
  await page.getByText("InputMaterializationError: Execution configuration unavailable", { exact: true }).waitFor()
  expect(await header.getAttribute("aria-expanded")).toBe("true")
  expect(await page.locator('[data-component="error-card"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)
