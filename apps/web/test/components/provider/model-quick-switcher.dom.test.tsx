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
        export const [selected, setSelected] = createSignal(models[0])
        export const useLocal = () => ({ model: {
          quickSwitcher: () => models,
          recent: () => models,
          current: selected,
          set: ref => setSelected(models.find(model => model.provider.id === ref.providerID && model.id === ref.modelID)),
        } })
        export const useGlobalSync = () => ({ data: { provider: { profiles: {} } } })
        export const useProviders = () => ({ ensureCatalog: async () => {} })
      `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { QuickSwitcherList } from ${JSON.stringify(`/@fs/${source}/components/provider/model-manager.tsx`)}
        import { selected } from "./state"
        import "@ericsanchezok/synergy-ui/styles"
        import ${JSON.stringify(`/@fs/${source}/index.css`)}
        const i18n = setupI18n({ locale: "en", messages: { en: {} } })
        render(() => <I18nProvider i18n={i18n}>
          <div style="display:flex;flex-direction:column;width:min(448px,calc(100vw - 32px));height:420px;margin:16px">
            <QuickSwitcherList onSelect={() => {}} />
          </div>
          <output aria-label="Selected account">{selected().provider.name}</output>
        </I18nProvider>, document.querySelector("#root"))
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

test("only Recent rows show account names beneath same-name models without overflowing narrow layouts", async () => {
  for (const width of [375, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } })
    try {
      await page.goto(server.url)
      const recent = page.locator('[data-slot="list-group"]').filter({
        has: page.locator('[data-slot="list-header"]', { hasText: "Recent" }),
      })
      await recent.getByRole("button").first().waitFor()
      expect(await recent.getByRole("button").allTextContents()).toEqual([
        "Shared modelOpenAI · Work",
        "Shared modelOpenAI · Personal account with a long identifying remark",
      ])
      const groups = page.locator('[data-slot="list-group"]').filter({
        hasNot: page.locator('[data-slot="list-header"]', { hasText: "Recent" }),
      })
      expect(await groups.getByRole("button").allTextContents()).toEqual(["Shared model", "Shared model"])
      const rows = await recent.getByRole("button").evaluateAll((buttons) =>
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
    expect(await rows.count()).toBe(2)
    expect(await rows.first().textContent()).toContain("OpenAI · Personal")
    await search.press("Enter")
    expect(await page.getByLabel("Selected account").textContent()).toBe(
      "OpenAI · Personal account with a long identifying remark",
    )
    expect(
      await page.locator('[data-slot="list-item"]:has([data-slot="list-item-selected-icon"])').textContent(),
    ).toContain("OpenAI · Personal")
  } finally {
    await page.close()
  }
})
