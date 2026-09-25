import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-interaction-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `
    window.attachments = []; window.detachments = []; window.commands = [];
    export const usePlatform = () => ({browserNative: {
      attachView: async input => window.attachments.push(input), resizeView: async () => {},
      detachView: async input => window.detachments.push(input), focusView: async () => {}, onEvent: () => () => {}
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, Show } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { BrowserPageDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/page-dialog.tsx`)}
    import { NativeBrowserSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/native-browser-surface.tsx`)}
    import { AddressBar } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/address-bar.tsx`)}
    import { BrowserStoreProvider, createBrowserStore } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-store.tsx`)}
    import { messages } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({locale:"en",messages:{en:messages}})
    const store = createBrowserStore()
    store.setSession("page", {id:"page-one",url:"about:blank",title:"Test",isLoading:false,lastActiveAt:null})
    store.setPresentation({kind:"native",protocolVersion:3,capabilities:{native:true,webrtc:true},reason:"desktop-local"})
    store._setSend(command => window.commands.push(command))
    window.browserFixture = store
    function App() {
      let container
      const [request,setRequest] = createSignal()
      window.showPageDialog = (type, defaultValue = "Default draft") => setRequest({type,defaultValue,pageId:"page-one",requestId:"request-one",message:"Name this draft"})
      return <div class="synergy-workbench-canvas">
        <button onClick={() => window.showPageDialog("prompt")}>Open prompt</button>
        <div class="browser-workspace" style="height:500px">
          <AddressBar activeUrl={() => "about:blank"} isLoading={() => false} hasPage={() => true} onNavigate={() => {}} onHistory={() => {}} onReload={() => {}} onStop={() => {}} onRequestDiagnostics={() => {}} />
          <div ref={container} style="position:relative;height:400px"><NativeBrowserSurface container={() => container} ownerKey="owner-one" /></div>
        </div>
        <Show when={request()} keyed>{request => <BrowserPageDialog request={request} onRespond={(accept,promptText) => {window.commands.push({accept,promptText});setRequest(undefined)}} />}</Show>
      </div>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><BrowserStoreProvider store={store}><App /></BrowserStoreProvider></DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: { alias: { "@/context/platform": path.join(directory, "platform.ts"), "@": source } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Fixture = Window & {
  commands: Array<{ accept?: boolean; promptText?: string }>
  attachments: Array<{ pageId: string; visible: boolean }>
  detachments: unknown[]
  showPageDialog(type: string, value?: string): void
  browserFixture: { setBrowserError(error: unknown): void; setAnnotationTarget(target: unknown): void }
}

test("prompt selects the default, submits edited and empty values, cancels separately, and restores focus", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open prompt" }).click()
  const input = page.getByRole("textbox", { name: "Response", exact: true })
  await input.waitFor()
  expect(
    await input.evaluate((node) => {
      const input = node as HTMLInputElement
      return [input.value, input.selectionStart, input.selectionEnd, document.activeElement === node]
    }),
  ).toEqual(["Default draft", 0, 13, true])
  await input.fill("New draft")
  await input.press("Enter")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: true,
    promptText: "New draft",
  })
  await page.waitForFunction(
    () => document.activeElement?.tagName === "BUTTON" && document.activeElement.textContent === "Open prompt",
  )
  expect(
    await page.getByRole("button", { name: "Open prompt" }).evaluate((node) => document.activeElement === node),
  ).toBe(true)
  await page.getByRole("button", { name: "Open prompt" }).click()
  await input.fill("")
  await input.press("Enter")
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: true,
    promptText: "",
  })
  await page.getByRole("button", { name: "Open prompt" }).click()
  await input.press("Escape")
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: false,
    promptText: undefined,
  })
  expect(errors).toEqual([])
})

test("alert has only acknowledgement and confirm retains cancellation at 375px", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(url)
  await page.evaluate(() => (window as unknown as Fixture).showPageDialog("alert"))
  await page.getByRole("dialog").waitFor()
  expect(await page.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "OK", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1)?.accept)).toBe(true)
  await page.evaluate(() => (window as unknown as Fixture).showPageDialog("confirm"))
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1)?.accept)).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("shared Browser menu returns focus on Escape and native view resumes only after the final blocker", async () => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(url)
  const menu = page.getByRole("button", { name: "Browser options", exact: true })
  await menu.click()
  await page.getByRole("switch").waitFor()
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments.at(-1)?.visible)).toBe(false)
  await page.evaluate(() =>
    (window as unknown as Fixture).browserFixture.setBrowserError({ severity: "error", message: "Test error" }),
  )
  await page.getByRole("switch").press("Escape")
  await page.getByRole("switch").waitFor({ state: "hidden" })
  expect(await menu.evaluate((node) => document.activeElement === node)).toBe(true)
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments.at(-1)?.visible)).toBe(false)
  await page.evaluate(() => (window as unknown as Fixture).browserFixture.setBrowserError(null))
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === true)
  await page.evaluate(() =>
    (window as unknown as Fixture).browserFixture.setAnnotationTarget({ displayX: 20, displayY: 20 }),
  )
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === false)
  await page.evaluate(() => (window as unknown as Fixture).browserFixture.setAnnotationTarget(null))
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === true)
  expect(await page.evaluate(() => (window as unknown as Fixture).detachments.length)).toBe(0)
  expect(
    await page.evaluate(() => [...new Set((window as unknown as Fixture).attachments.map((x) => x.pageId))]),
  ).toEqual(["page-one"])
  expect(errors).toEqual([])
})
