import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let fixture: string
let server: BrowserFixture
let browser: Browser
const source = path.resolve(import.meta.dir, "../../../src")
const current = "http://current.test"
const remote = "http://remote.test"
type FixtureWindow = Window & {
  setFeatures(features: string[] | undefined): void
  opened: string[]
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".project-capabilities-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "contexts.ts"),
    `
    import { createSignal } from "solid-js"
    const [selected, setSelected] = createSignal({ apiVersion: 1, components: [], features: ["workbench"] })
    window.setFeatures = features => setSelected(features ? { apiVersion: 1, components: [], features } : undefined)
    export const useGlobalSDK = () => ({ url: ${JSON.stringify(current)}, capabilities: { current: selected } })
    export const useServer = () => ({ url: ${JSON.stringify(current)} })
    export const usePlatform = () => ({})
  `,
  )
  await Bun.write(
    path.join(fixture, "picker.ts"),
    `
    export const useProjectDirectoryPicker = () => ({ pickProjectDirectories: async () => ({ directoryPaths: ["/fixture/project"] }) })
  `,
  )
  await Bun.write(
    path.join(fixture, "computer.tsx"),
    `
    export const ComputerMenu = props => <button type="button" onClick={() => props.onChange(${JSON.stringify(remote)})}>Remote computer</button>
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { DialogCreateProject } from "/@fs/${source}/components/dialog/dialog-create-project.tsx"
    import { messages as en } from "/@fs/${source}/locales/en/messages.po"
    window.opened = []
    const i18n = setupI18n({ locale: "en", messages: { en } })
    function Fixture() {
      const dialog = useDialog()
      return <button onClick={() => dialog.show(() => <DialogCreateProject onCreated={(id, url) => window.opened.push(url + "/" + id)} />)}>New project</button>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: fixture,
    localized: true,
    aliases: [
      ...["global-sdk", "server", "platform"].map((name) => ({
        find: "@/context/" + name,
        replacement: path.join(fixture, "contexts.ts"),
      })),
      { find: "./project-directory-picker", replacement: path.join(fixture, "picker.ts") },
      { find: "./computer-menu", replacement: path.join(fixture, "computer.tsx") },
      { find: "@/", replacement: source + "/" },
    ],
  })
  browser = await chromium.launch({ headless: true })
}, 100000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function open() {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  await page.goto(server.url)
  await page.getByRole("button", { name: "New project", exact: true }).click()
  await page.locator(".project-create-dialog").waitFor()
  return page
}

async function setFeatures(page: Page, features: string[] | undefined) {
  await page.evaluate((value) => (window as unknown as FixtureWindow).setFeatures(value), features)
}

test("remote project entry remains absent until that server advertises Workbench", async () => {
  const page = await open()
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: string[] = []
  await page.route(remote + "/**", async (route) => {
    requests.push(new URL(route.request().url()).pathname)
    await ready
    await route.fulfill({ json: { apiVersion: 1, components: [{ id: "workbench" }], features: [] } })
  })
  await page.getByRole("button", { name: "Remote computer" }).click()
  expect(await page.locator(".project-create-dialog").count()).toBe(0)
  release()
  await page.getByRole("button", { name: "New project", exact: true }).waitFor({ state: "visible" })
  expect(await page.locator(".project-create-dialog").count()).toBe(0)
  expect(requests).toEqual(["/global/capabilities"])
  await page.close()
})

test("a removed selection ignores a late project creation response", async () => {
  const page = await open()
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let creating!: () => void
  const requested = new Promise<void>((resolve) => {
    creating = resolve
  })
  await page.route(current + "/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/global/capabilities") {
      await route.fulfill({ json: { apiVersion: 1, components: [], features: ["workbench"] } })
      return
    }
    creating()
    await ready
    await route.fulfill({ json: { scope: { id: "late-project", name: "project" }, existing: false } })
  })
  await page.getByRole("button", { name: "Choose folders", exact: true }).click()
  await page.locator(".project-submit").click()
  await requested
  await setFeatures(page, undefined)
  expect(await page.locator(".project-create-dialog").count()).toBe(0)
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/global/project")
  release()
  await response
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).opened)).toEqual([])
  await page.close()
})
