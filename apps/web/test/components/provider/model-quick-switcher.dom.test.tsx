import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".quick-switcher-fixture-"))
  const state = path.join(directory, "state.ts")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      state,
      `
        import { createSignal } from "solid-js"
        const models = [
          { id: "shared-model", name: "Shared model", cost: { input: 1, output: 1 }, provider: { id: "work", name: "OpenAI · Work" } },
          { id: "shared-model", name: "Shared model", cost: { input: 1, output: 1 }, provider: { id: "personal", name: "OpenAI · Personal account with a long identifying remark" } },
        ]
        const catalogOnly = { id: "catalog-only", name: "Catalog only model", cost: { input: 1, output: 1 }, provider: models[0].provider }
        const shortcuts = new URLSearchParams(location.search).has("no-common") ? [] : models
        export const [selected, setSelected] = createSignal(models[0])
        export const useLocal = () => ({ model: {
          all: () => [...models, catalogOnly],
          quickSwitcher: () => shortcuts,
          recent: () => shortcuts,
          current: selected,
          set: ref => setSelected([...models, catalogOnly].find(model => model.provider.id === ref.providerID && model.id === ref.modelID)),
        } })
        export const useGlobalSync = () => ({ data: { provider: { profiles: {} } } })
        export const useProviders = () => ({ ensureCatalog: async () => {}, all: () => models.map(model => model.provider) })
      `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
        import { MetaProvider } from "@solidjs/meta"
        import { Font } from "@ericsanchezok/synergy-ui/font"
        import { ModelSelectionList } from ${JSON.stringify(`/@fs/${source}/components/provider/model-manager.tsx`)}
        import { selected } from "./state"
        import "@ericsanchezok/synergy-ui/styles"
        import ${JSON.stringify(`/@fs/${source}/index.css`)}
        import { messages as en } from "@/locales/en/messages.po"
        import { messages as zh } from "@/locales/zh-CN/messages.po"
        const params = new URLSearchParams(location.search)
        const i18n = setupI18n({ locale: params.get("locale") ?? "en", messages: { en, "zh-CN": zh } })
        const Fixture = () => {
          useTheme().setColorScheme(params.get("theme") ?? "light")
          return <>
          <div style="display:flex;flex-direction:column;width:min(448px,calc(100vw - 32px));height:420px;margin:16px">
            <ModelSelectionList onSelect={() => {}} />
          </div>
          <output aria-label="Selected account">{selected().provider.name}</output>
          <output aria-label="Selected model">{selected().id}</output>
          </>
        }
        render(() => <I18nProvider i18n={i18n}><ThemeProvider><MetaProvider><Font /><Fixture /></MetaProvider></ThemeProvider></I18nProvider>, document.querySelector("#root"))
      `,
    ),
  ])
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: "@/context/local", replacement: state },
      { find: "@/context/global-sync", replacement: state },
      { find: "@/hooks/use-providers", replacement: state },
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("common rows merge shortcut copies, show account names and keep one selected marker", async () => {
  for (const [width, theme] of [
    [375, "light"],
    [1280, "dark"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 720 } })
    try {
      await page.goto(`${server.url}?theme=${theme}`)
      const common = page.locator('[data-slot="list-group"]').filter({
        has: page.locator('[data-slot="list-header"]', { hasText: "Common models" }),
      })
      await page.locator('[data-slot="list-item"]').first().waitFor()
      expect(await page.locator('[data-slot="list-header"]').allTextContents()).toEqual(["Common models"])
      expect(await common.getByRole("button").allTextContents()).toEqual([
        "Shared modelOpenAI · Work",
        "Shared modelOpenAI · Personal account with a long identifying remark",
      ])
      expect(await page.locator('[data-slot="list-item"]').count()).toBe(2)
      expect(await page.locator('[data-slot="list-item-selected-icon"]').count()).toBe(1)
      const rows = await common.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const model = button.querySelector(".model-manager-model-name")!.getBoundingClientRect()
          const provider = button.querySelector(".model-manager-provider-name")!.getBoundingClientRect()
          const row = button.getBoundingClientRect()
          const marker = button.querySelector('[data-slot="list-item-selected-icon"]')?.getBoundingClientRect()
          return {
            twoLines: provider.top >= model.bottom,
            fits: row.right <= innerWidth && provider.right <= row.right,
            markerFits: !marker || marker.left >= provider.right,
          }
        }),
      )
      expect(rows).toEqual([
        { twoLines: true, fits: true, markerFits: true },
        { twoLines: true, fits: true, markerFits: true },
      ])
    } finally {
      await page.close()
    }
  }
})

test("account search and keyboard selection keep identical model IDs bound to the chosen provider", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    const search = page.getByRole("textbox", { name: "Search models" })
    await search.fill("Personal")
    const rows = page.locator('[data-slot="list-item"]')
    await rows.first().waitFor()
    expect(await rows.count()).toBe(1)
    expect(await rows.first().textContent()).toContain("OpenAI · Personal")
    await search.press("Enter")
    expect(await page.getByLabel("Selected account").textContent()).toBe(
      "OpenAI · Personal account with a long identifying remark",
    )
    expect(
      (await page.locator('[data-slot="list-item"]:has([data-slot="list-item-selected-icon"])').allTextContents()).join(
        " ",
      ),
    ).toContain("OpenAI · Personal")
  } finally {
    await page.close()
  }
})

test("browsing the full catalog keeps one copy per account and returns without remounting search", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    const search = page.getByRole("textbox", { name: "Search models" })
    const input = await search.elementHandle()
    await page.getByRole("button", { name: "Browse all models", exact: true }).click()
    expect((await page.locator('[data-slot="list-item"]').allTextContents()).sort()).toEqual([
      "Catalog only model",
      "Shared model",
      "Shared model",
    ])
    expect(await page.locator('[data-slot="list-item-selected-icon"]').count()).toBe(1)
    expect(await page.locator(".model-manager-provider-name").count()).toBe(0)
    expect(await input!.evaluate((node) => node.isConnected)).toBe(true)
    await page.getByRole("button", { name: "Back to common models", exact: true }).click()
    await page.getByText("Common models", { exact: true }).waitFor()
    expect(await page.locator('[data-slot="list-item"]').count()).toBe(2)
    expect(await input!.evaluate((node) => node.isConnected)).toBe(true)
  } finally {
    await page.close()
  }
})

test("search always includes catalog-only models and clearing restores the previous view", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    const search = page.getByRole("textbox", { name: "Search models" })
    await search.fill("Catalog only")
    const row = page.locator('[data-slot="list-item"]')
    await row.filter({ hasText: "Catalog only model" }).waitFor()
    expect(await row.count()).toBe(1)
    expect(await row.textContent()).toContain("OpenAI · Work")
    expect(await page.locator('[data-slot="list-header"]').count()).toBe(0)
    await search.press("Enter")
    expect(await page.getByLabel("Selected model").textContent()).toBe("catalog-only")
    await page.getByRole("button", { name: "Clear search", exact: true }).click()
    await page.getByText("Common models", { exact: true }).waitFor()
    expect(await row.count()).toBe(2)
    await page.getByRole("button", { name: "Browse all models", exact: true }).click()
    await search.fill("Shared model")
    await row.filter({ hasText: "OpenAI · Personal" }).waitFor()
    expect(await row.count()).toBe(2)
    expect(await page.locator('[data-slot="list-header"]').count()).toBe(0)
    await search.fill("no matching model zzz")
    await page.locator('[data-slot="list-empty-state"]').waitFor()
    await page.getByRole("button", { name: "Clear search", exact: true }).click()
    await page.getByRole("button", { name: "Back to common models", exact: true }).waitFor()
    expect(await row.count()).toBe(3)
    expect(await page.locator('[data-slot="list-item-selected-icon"]').count()).toBe(1)
  } finally {
    await page.close()
  }
})

test("an empty common list falls back to the full catalog with localized navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 }, isMobile: true, hasTouch: true })
  try {
    await page.goto(`${server.url}?no-common`)
    await page.getByText("Catalog only model", { exact: true }).waitFor()
    expect(await page.locator('[data-slot="list-item"]').count()).toBe(3)
    expect(await page.getByRole("button", { name: "Browse all models", exact: true }).count()).toBe(0)
    await page.goto(`${server.url}?locale=zh-CN`)
    await page.getByText("常用模型", { exact: true }).waitFor()
    const browse = page.getByRole("button", { name: "浏览全部模型", exact: true })
    expect(Math.round((await browse.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    await browse.click()
    await page.getByRole("button", { name: "返回常用模型", exact: true }).click()
    await page.getByText("常用模型", { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test("Tab reaches catalog navigation without selecting a model", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    const search = page.getByRole("textbox", { name: "Search models" })
    await search.focus()
    for (let index = 0; index < 3; index++) await page.keyboard.press("Tab")
    const browse = page.getByRole("button", { name: "Browse all models", exact: true })
    expect(await browse.evaluate((node) => node === document.activeElement)).toBe(true)
    await page.keyboard.press("Enter")
    await page.getByText("Catalog only model", { exact: true }).waitFor()
    expect(await page.getByLabel("Selected model").textContent()).toBe("shared-model")
    await page.keyboard.press("Enter")
    await page.getByText("Common models", { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})
