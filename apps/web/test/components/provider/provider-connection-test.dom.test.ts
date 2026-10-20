import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let fixture: BrowserFixture, directory: string, browser: Browser, page: Page
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".connection-test-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    export const useGlobalSDK = () => ({ url: "fixture", client: { provider: { connection: { test: (input, options) => {
      window.calls = (window.calls || 0) + 1
      return new Promise((resolve, reject) => {
        window.complete = (success) => resolve({data:{providerID:input.providerID,modelID:"fixture-model",durationMs:12,success,error:success?undefined:{kind:"authentication",statusCode:401}}})
        options.signal.addEventListener("abort", () => { window.aborted=true; reject(new Error("aborted")) })
      })
    } } } } })
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {createSignal} from "solid-js"
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {ProviderConnectionTest} from ${JSON.stringify(`${source}/components/provider/ProviderConnectionFlow.tsx`)}
    import "@ericsanchezok/synergy-ui/styles"
    function App(){ const [provider,setProvider]=createSignal("first"),[disabled,setDisabled]=createSignal(false)
      window.selectProvider=setProvider;window.disableTest=setDisabled
      return <I18nProvider i18n={setupI18n({locale:"en"})}><ProviderConnectionTest providerID={provider()} disabled={disabled()}/></I18nProvider>
    }
    render(()=><App/>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: "@/context/global-sdk", replacement: path.join(directory, "sdk.ts") },
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
test("connection results come from the request and stale pending results cannot update another account", async () => {
  await page.goto(fixture.url)
  const button = page.getByRole("button", { name: "Test connection", exact: true })
  await button.click()
  expect(await page.getByRole("button", { name: "Testing…" }).isDisabled()).toBe(true)
  await page.evaluate(() => Reflect.get(window, "complete")(false))
  await page.getByRole("status").filter({ hasText: "Credentials were rejected" }).waitFor()
  expect(await page.getByRole("status").textContent()).toContain("HTTP 401")
  await button.click()
  await page.evaluate(() => Reflect.get(window, "complete")(true))
  await page.getByRole("status").filter({ hasText: "Model request succeeded" }).waitFor()
  expect(await page.getByRole("status").textContent()).toContain("fixture-model")
  await button.click()
  await page.evaluate(() => Reflect.get(window, "selectProvider")("second"))
  expect(await page.evaluate(() => Reflect.get(window, "aborted"))).toBe(true)
  await page.evaluate(() => Reflect.get(window, "complete")(true))
  expect(await page.getByRole("status").count()).toBe(0)
  await page.evaluate(() => Reflect.get(window, "disableTest")(true))
  expect(await button.isDisabled()).toBe(true)
  expect(await page.getByText("Save changes before testing the connection.").isVisible()).toBe(true)
})
