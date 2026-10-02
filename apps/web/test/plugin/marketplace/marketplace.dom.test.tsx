import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(30000)
let directory: string
let browser: Browser
let page: Page
let server: ViteDevServer
let url: string
let installedFailure = false
let holdSearch: Promise<void> | undefined
let holdVersions: Promise<void> | undefined
let installRequests = 0
let approvalRequests = 0
let approvalFailure = false
let installed = false
let releaseVersion = "1.0.0"
let installedVersion = "1.0.0"
let updateFailure = false
let uninstallFailure = false
let mutationBody: unknown
const source = path.resolve(import.meta.dir, "../../../src")
const plugin = {
  id: "fixture",
  name: "Test plugin",
  icon: { type: "lucide", name: "unsupported-fixture-icon" },
  description:
    "A long purpose description that remains readable while the actual installation state stays inside its card.",
  keywords: [],
  source: "official",
  updatedAt: 1,
  version: "1.0.0",
  latestVersion: "1.0.0",
  tools: ["inspect"],
  uiSurfaces: [],
  trustTier: "declarative",
  runtimeMode: "process",
  downloads: 0,
  verified: true,
  official: true,
  author: { name: "Fixture" },
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".marketplace-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `import {useLingui} from "@lingui/solid"; import {createIntlFormatter} from "/@fs/${source}/context/locale/formatter.ts"; export const useLocale=()=>({i18n:useLingui().i18n(),controller:{activeLocale:()=>"en"},fmt:createIntlFormatter(()=>"en")})`,
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"; export const useGlobalSDK=()=>({client:createSynergyClient({baseUrl:location.origin+"/fixture",throwOnError:true})})`,
  )
  await Bun.write(path.join(directory, "close.ts"), "export const useWorkspaceMobileHeaderClose=()=>()=>{}")
  await Bun.write(
    path.join(directory, "host.ts"),
    "export const usePluginHost=()=>({reload:async()=>{},status:()=>new Map(),extensions:()=>[]})",
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {Router} from "@solidjs/router"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {MarketplacePage} from "/@fs/${source}/plugin/marketplace/MarketplacePage.tsx"
    import {MarketplacePluginIcon} from "/@fs/${source}/plugin/marketplace/MarketplacePluginIcon.tsx"
    import {messages as en} from "/@fs/${source}/locales/en/messages.po"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${source}/index.css"
    const i18n=setupI18n({locale:"en",messages:{en}})
    function IconFixture() {
      const [url,setUrl]=createSignal("/icon-delayed.svg")
      return <><MarketplacePluginIcon class="plugin-marketplace-plugin-icon" plugin={{name:"Test plugin",keywords:[],icon:{type:"image",url:url()}}}/><button onClick={()=>setUrl("/icon-unavailable.svg")}>Change icon</button></>
    }
    const deepLink=new URLSearchParams(location.search).has("deep-link")
    render(()=><I18nProvider i18n={i18n}><DialogProvider><Router root={()=> <div style="height:100dvh">{location.search.includes("icon") ? <IconFixture/> : <MarketplacePage initialPluginId={deepLink ? "fixture" : undefined} initialSource={deepLink ? "local" : undefined}/>}</div>}/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@/context/global-sdk", replacement: path.join(directory, "sdk.ts") },
        { find: "@/components/workspace/mobile-header-close", replacement: path.join(directory, "close.ts") },
        { find: /^@\/plugin$/, replacement: path.join(directory, "host.ts") },
        { find: "../host", replacement: path.join(directory, "host.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@solidjs/router", "@lingui/core", "@lingui/solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.route("**/fixture/**", async (route) => {
    const requestURL = new URL(route.request().url())
    if (requestURL.pathname === "/fixture/api/plugins")
      return route.fulfill({
        status: installedFailure ? 503 : 200,
        json: installedFailure
          ? { message: "Unavailable" }
          : installed
            ? [
                {
                  id: "fixture",
                  name: "Test plugin",
                  version: installedVersion,
                  installation: { kind: "registry", registry: "official", spec: "fixture" },
                  trust: "declarative",
                  health: "loaded",
                  loaded: true,
                  capabilities: ["filesystem.read"],
                  tools: [],
                  operations: [],
                  uiContributions: 0,
                  contributionHealth: {},
                },
              ]
            : [],
      })
    if (requestURL.pathname === "/fixture/api/registry/search") {
      if (requestURL.searchParams.get("q") === "old") await holdSearch
      return route.fulfill({
        json: {
          plugins:
            requestURL.searchParams.get("q") === "missing"
              ? []
              : [
                  plugin,
                  ...Array.from({ length: 10 }, (_, index) => ({
                    ...plugin,
                    id: `fixture-${index}`,
                    name: `Catalog entry ${index}`,
                  })),
                ],
          total: 11,
        },
      })
    }
    if (requestURL.pathname.endsWith("/versions")) {
      await holdVersions
      return route.fulfill({
        json: [
          {
            version: releaseVersion,
            apiVersion: "4.0",
            compatibility: { synergy: ">=1.0.0" },
            publishedAt: 1,
            featuresSummary: [
              {
                key: "tool:inspect",
                title: "Inspect",
                description: "Fixture tool instructions are available in technical definitions.",
              },
              { key: "agents", title: "Specialized agents", description: "Provides 3 specialized agents." },
            ],
            permissionsSummary: [
              { key: "filesystem.read", title: "Read files", description: "Read files selected for this plugin" },
            ],
          },
        ],
      })
    }
    if (requestURL.pathname === "/fixture/api/plugins/registry/install") {
      installRequests++
      const review = {
        target: { kind: "registry", pluginId: "fixture", version: "1.0.0", source: "official" },
        pluginId: "fixture",
        name: "Test plugin",
        version: "1.0.0",
        apiVersion: "4.0",
        generation: "fixture-build",
        source: "official",
        capabilities: ["filesystem.read"],
        trust: "declarative",
        access: [
          { key: "filesystem.read", category: "files", title: "Read files", description: "Read selected files" },
        ],
        added: [],
        broadened: [],
        removed: [],
        requiresConfirmation: true,
        reviewToken: "fixture-review",
      }
      return route.fulfill({ status: 409, json: { code: "approval_required", message: "Approval required", review } })
    }
    if (requestURL.pathname === "/fixture/api/plugins/approve") {
      approvalRequests++
      if (approvalFailure) return route.fulfill({ status: 503, json: { message: "Controlled approval failure" } })
      installed = true
      return route.fulfill({ json: { success: true } })
    }
    if (requestURL.pathname === "/fixture/api/plugins/registry/update") {
      mutationBody = route.request().postDataJSON()
      if (updateFailure) return route.fulfill({ status: 503, json: { message: "Controlled update failure" } })
      installedVersion = releaseVersion
      return route.fulfill({ json: { success: true } })
    }
    if (requestURL.pathname === "/fixture/api/plugins/fixture" && route.request().method() === "DELETE") {
      if (uninstallFailure) return route.fulfill({ status: 503, json: { message: "Controlled uninstall failure" } })
      installed = false
      return route.fulfill({ json: { success: true } })
    }
    return route.fulfill({ status: 404, json: { message: "Unexpected fixture request" } })
  })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("an unavailable catalog icon has a name initial instead of an empty image", async () => {
  await page.goto(url)
  const card = page.getByRole("button", { name: /Test plugin/ })
  await card.waitFor()
  expect(await card.locator(".plugin-marketplace-monogram").textContent()).toBe("T")
})

test("pending and failed brand images retain their name initial while successful artwork keeps its proportions", async () => {
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/icon-delayed.svg", async (route) => {
    await pending
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="black"/></svg>',
    })
  })
  await page.route("**/icon-unavailable.svg", (route) => route.abort("failed"))
  try {
    await page.goto(`${url}?icon`, { waitUntil: "domcontentloaded" })
    const initial = page.locator(".plugin-marketplace-monogram")
    await initial.waitFor()
    expect(await initial.textContent()).toBe("T")
    release()
    const image = page.getByRole("img", { name: "Test plugin icon", exact: true })
    await image.waitFor()
    expect(
      await image.evaluate((element) => {
        const artwork = element as HTMLImageElement
        return artwork.naturalWidth / artwork.naturalHeight
      }),
    ).toBe(2)
    expect(await image.evaluate((element) => getComputedStyle(element).objectFit)).toBe("contain")
    expect(await initial.count()).toBe(0)
    await page.getByRole("button", { name: "Change icon", exact: true }).click()
    await initial.waitFor()
    expect(await initial.textContent()).toBe("T")
    await image.waitFor({ state: "detached" })
  } finally {
    release()
    await page.unroute("**/icon-delayed.svg")
    await page.unroute("**/icon-unavailable.svg")
  }
})

test("discovery cards contain installation state at desktop and phone widths and return to the same query", async () => {
  installedFailure = false
  await page.goto(url)
  const search = page.getByRole("textbox", { name: "Search plugins" })
  await search.fill("Test")
  const card = page.getByRole("button", { name: /Test plugin/ })
  await card.waitFor()
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 })
    const state = card.locator(".plugin-marketplace-row-status")
    expect(await state.isVisible()).toBe(true)
    const outer = (await card.boundingBox())!
    const inner = (await state.boundingBox())!
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height)
  }
  await card.click()
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await search.inputValue()).toBe("Test")
  expect(await card.evaluate((el) => el === document.activeElement)).toBe(true)
})

test("a delayed previous search cannot replace the current empty result", async () => {
  await page.goto(url)
  let release: () => void = () => {}
  holdSearch = new Promise<void>((resolve) => {
    release = resolve
  })
  const search = page.getByRole("textbox", { name: "Search plugins" })
  const pending = page.waitForRequest((request) => new URL(request.url()).searchParams.get("q") === "old")
  await search.fill("old")
  await pending
  await search.fill("missing")
  await page.getByText("No plugins found", { exact: true }).waitFor()
  const previousResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("q") === "old")
  release()
  holdSearch = undefined
  await previousResponse
  expect(await page.getByRole("button", { name: /Test plugin/ }).count()).toBe(0)
  expect(await page.getByText('No results for "missing".', { exact: true }).isVisible()).toBe(true)
})

test("a failed installation-state group leaves plugin purpose readable and requires retry before installation", async () => {
  installedFailure = true
  try {
    await page.goto(url)
    await page.getByRole("button", { name: /Test plugin/ }).click()
    const detail = page.getByRole("dialog", { name: "Test plugin", exact: true })
    await detail.getByText(plugin.description, { exact: true }).waitFor()
    await detail.getByText("Installation status could not be refreshed.", { exact: true }).waitFor()
    expect(await detail.getByRole("button", { name: "Install", exact: true }).isDisabled()).toBe(true)
    installedFailure = false
    await detail.getByRole("button", { name: "Retry", exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>(".plugin-detail-primary-action")?.disabled,
    )
    expect(await detail.getByRole("button", { name: "Install", exact: true }).isEnabled()).toBe(true)
    await page.keyboard.press("Escape")
  } finally {
    installedFailure = false
  }
})

test("clearing plugin search returns focus to the retained input", async () => {
  installedFailure = false
  await page.goto(url)
  const search = page.getByRole("textbox", { name: "Search plugins" })
  await search.fill("Test")
  await page.getByRole("button", { name: "Clear search", exact: true }).click()
  expect(await search.inputValue()).toBe("")
  expect(await search.evaluate((element) => element === document.activeElement)).toBe(true)
})

test("installed request failures show recovery instead of an empty installation list", async () => {
  installedFailure = true
  await page.goto(url)
  await page.getByRole("tab", { name: "Installed", exact: true }).click()
  await page.getByText("Unable to load installed plugins", { exact: true }).waitFor()
  expect(await page.getByText("No plugins installed", { exact: true }).count()).toBe(0)
  installedFailure = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByText("No plugins installed", { exact: true }).waitFor()
})

test("plugin purpose remains visible while its permissions load independently", async () => {
  installedFailure = false
  let release: () => void = () => {}
  holdVersions = new Promise<void>((resolve) => (release = resolve))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(url)
  await page.getByRole("button", { name: /Test plugin/ }).click()
  await page.getByRole("dialog").waitFor()
  await page.getByRole("dialog").getByText(plugin.description, { exact: true }).waitFor()
  const absent = await page.getByText("No special permissions declared.", { exact: true }).count()
  const loading = await page.getByRole("status").filter({ hasText: "Loading permissions" }).count()
  release()
  holdVersions = undefined
  expect(absent).toBe(0)
  expect(loading).toBe(1)
  await page.getByText("Read files", { exact: true }).waitFor()
  await page.keyboard.press("Escape")
})

test("install approval closes one layer at a time and cannot approve by dismissal", async () => {
  installedFailure = false
  installRequests = 0
  approvalRequests = 0
  await page.goto(url)
  const search = page.getByRole("textbox", { name: "Search plugins" })
  await search.fill("Test")
  const card = page.getByRole("button", { name: /Test plugin/ })
  await card.click()
  const install = page.getByRole("button", { name: "Install", exact: true })
  await install.click()
  await page.getByRole("dialog", { name: "Confirm plugin install" }).waitFor()
  expect(await page.locator('[data-slot="dialog-content"]').count()).toBe(2)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Confirm plugin install" }).waitFor({ state: "detached" })
  expect(approvalRequests).toBe(0)
  expect(installRequests).toBe(1)
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.waitForFunction(() => document.querySelector(".plugin-detail-primary-action") === document.activeElement)
  await page.keyboard.press("Escape")
  expect(await search.inputValue()).toBe("Test")
  await page.waitForFunction(() => document.activeElement?.classList.contains("plugin-marketplace-row"))
})

test("failed approval keeps the review and a successful retry publishes the installed state", async () => {
  installed = false
  installedFailure = false
  approvalFailure = true
  approvalRequests = 0
  await page.goto(url)
  await page.getByRole("button", { name: /Test plugin/ }).click()
  await page.getByRole("button", { name: "Install", exact: true }).click()
  const review = page.getByRole("dialog", { name: "Confirm plugin install" })
  await review.waitFor()
  await review.getByRole("button", { name: "Confirm & install", exact: true }).click()
  await review.getByText("Controlled approval failure", { exact: true }).waitFor()
  expect(await review.isVisible()).toBe(true)
  approvalFailure = false
  await review.getByRole("button", { name: "Confirm & install", exact: true }).click()
  await review.waitFor({ state: "detached" })
  expect(approvalRequests).toBe(2)
  await page.getByRole("button", { name: "Close plugin details", exact: true }).click()
  await page.getByRole("tab", { name: "Installed", exact: true }).click()
  const row = page.locator(".plugin-marketplace-installed-row").filter({ hasText: "Test plugin" })
  await row.waitFor()
  expect(await row.getByRole("button", { name: "Manage", exact: true }).isVisible()).toBe(true)
  expect(await row.getByText("Active", { exact: true }).isVisible()).toBe(true)
  installed = false
})

test("installed registry plugins retain their source for update and recover from maintenance failures", async () => {
  installed = true
  installedVersion = "1.0.0"
  releaseVersion = "2.0.0"
  updateFailure = true
  uninstallFailure = true
  try {
    await page.goto(url)
    await page.getByRole("tab", { name: "Installed", exact: true }).click()
    await page.getByRole("button", { name: "Manage", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Test plugin", exact: true })
    await detail.getByRole("button", { name: "Update to v2.0.0", exact: true }).click()
    await detail.getByText("Controlled update failure", { exact: true }).waitFor()
    expect(mutationBody).toEqual({ pluginId: "fixture", version: "2.0.0", source: "official" })
    updateFailure = false
    await detail.getByRole("button", { name: "Update to v2.0.0", exact: true }).click()
    await detail.getByRole("button", { name: "Installed v2.0.0", exact: true }).waitFor()
    await detail.getByRole("button", { name: "Uninstall", exact: true }).click()
    const confirm = page.getByRole("dialog").last()
    await confirm.getByRole("button", { name: "Uninstall", exact: true }).click()
    await confirm.getByText("Controlled uninstall failure", { exact: true }).waitFor()
    expect(await page.getByRole("dialog", { name: "Test plugin", exact: true, includeHidden: true }).count()).toBe(1)
    uninstallFailure = false
    await confirm.getByRole("button", { name: "Uninstall", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await page.getByText("No plugins installed", { exact: true }).waitFor()
  } finally {
    installed = false
    releaseVersion = "1.0.0"
    installedVersion = "1.0.0"
    updateFailure = false
    uninstallFailure = false
  }
})

test("default plugin reading presents a capability summary before optional technical definitions", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: /Test plugin/ }).click()
  const detail = page.getByRole("dialog", { name: "Test plugin", exact: true })
  await detail.getByText("Read files", { exact: true }).waitFor()
  expect(
    await detail
      .getByText("Fixture tool instructions are available in technical definitions.", { exact: true })
      .isVisible(),
  ).toBe(false)
  expect(await detail.getByText("1 tools · 0 UI surfaces", { exact: true }).isVisible()).toBe(true)
  expect(await detail.getByText(/0 operations/).count()).toBe(0)
  await detail.getByText("Technical definitions", { exact: true }).click()
  expect(
    await detail
      .getByText("Fixture tool instructions are available in technical definitions.", { exact: true })
      .isVisible(),
  ).toBe(true)
  await page.keyboard.press("Escape")
})

test("a plugin deep link keeps its local catalog identity and returns to discovery", async () => {
  const requestedSources: string[] = []
  const observe = (request: import("playwright").Request) => {
    const target = new URL(request.url())
    if (target.pathname.includes("/api/registry/")) requestedSources.push(target.searchParams.get("source") ?? "")
  }
  page.on("request", observe)
  try {
    await page.goto(`${url}?deep-link`)
    const detail = page.getByRole("dialog", { name: "Test plugin", exact: true })
    await detail.getByText("Read files", { exact: true }).waitFor()
    expect(requestedSources.length).toBeGreaterThanOrEqual(2)
    expect(requestedSources.every((source) => source === "local")).toBe(true)
    await page.keyboard.press("Escape")
    await detail.waitFor({ state: "detached" })
    expect(new URL(page.url()).pathname).toBe("/plugins/marketplace")
    expect(await page.getByRole("radio", { name: "Local registry", exact: true }).isChecked()).toBe(true)
  } finally {
    page.off("request", observe)
  }
})

test("Escape closes plugin reading while release permissions are still loading", async () => {
  let release: () => void = () => {}
  holdVersions = new Promise<void>((resolve) => (release = resolve))
  try {
    await page.goto(url)
    await page.getByRole("button", { name: /Test plugin/ }).click()
    await page.getByRole("status").filter({ hasText: "Loading permissions" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "detached" })
  } finally {
    release()
    holdVersions = undefined
  }
})
