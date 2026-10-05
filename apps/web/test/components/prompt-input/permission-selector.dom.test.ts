import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".permission-selector-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    'import { useLingui } from "@lingui/solid"; export const useLocale = () => ({ controller: { activeLocale: () => "en" }, i18n: { _: useLingui()._ } })',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { MetaProvider } from "@solidjs/meta"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { PermissionModeSelector } from ${JSON.stringify(`/@fs/${source}/components/prompt-input/permission-selector.tsx`)}
    import { permissionModeVisual } from ${JSON.stringify(`/@fs/${source}/components/prompt-input/permission-modes.ts`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function Fixture() {
      const theme = useTheme()
      const [profile, setProfile] = createSignal("full_access")
      const [switching, setSwitching] = createSignal(false)
      return <div class="synergy-workbench-canvas" style="min-height:100dvh;padding:24px;background:var(--background-stronger)">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <button onClick={() => theme.setColorScheme("light")}>Light</button>
          <button onClick={() => theme.setColorScheme("dark")}>Dark</button>
          <button onClick={() => theme.setThemeId("synergy")}>Synergy skin</button>
          <button onClick={() => theme.setThemeId("catppuccin")}>Alternate skin</button>
          <button onClick={() => setSwitching(!switching())}>Toggle switching</button>
        </div>
        <div class="prompt-input-shell" style="margin-top:320px;max-width:600px">
          <div class="prompt-input-toolbar flex items-center">
            <PermissionModeSelector switching={switching} selectedProfile={profile} activeMode={() => permissionModeVisual(profile())}
              updateProfile={(value, close) => {setProfile(value);close?.()}} />
          </div>
        </div>
      </div>
    }
    render(() => <MetaProvider><Font /><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></MetaProvider>, document.getElementById("root"))
    `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid", "fuzzysort"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 800, height: 650 }, reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page
    .locator(".prompt-input-toolbar-button")
    .waitFor({ timeout: 15_000 })
    .catch((error) => {
      throw new AggregateError(
        [error, ...errors.map((message) => new Error(message))],
        "Permission fixture did not mount",
      )
    })
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.fonts.check('12px "Inter"'))).toBe(true)
}, 30_000)

afterEach(async () => {
  await page?.close()
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60_000)

async function appearance(selector: string) {
  return page.locator(selector).evaluate((element) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    }
    const style = getComputedStyle(element)
    let background = [255, 255, 255]
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
    for (const ancestor of ancestors) {
      const [r, g, b, alpha] = rgb(getComputedStyle(ancestor).backgroundColor)
      background = [r!, g!, b!].map(
        (channel, index) => channel * (alpha! / 255) + background[index]! * (1 - alpha! / 255),
      )
    }
    const color = rgb(style.color).slice(0, 3)
    const luminance = (channels: number[]) =>
      channels
        .map((value) => {
          const channel = value / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    const a = luminance(color)
    const b = luminance(background)
    return { color, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
  })
}

for (const [scheme, color] of [
  ["Light", [196, 72, 28]],
  ["Dark", [255, 138, 80]],
] as const) {
  test(`${scheme}: Full Access stays distinct and readable at rest, hover and in the menu`, async () => {
    await page.getByRole("button", { name: scheme, exact: true }).click()
    const trigger = page.locator(".prompt-input-toolbar-button")
    const label = ".prompt-input-toolbar-button > span"
    const icon = '.prompt-input-toolbar-button [data-slot="icon-svg"]'
    expect((await appearance(label)).color).toEqual([...color])
    expect((await appearance(icon)).color).toEqual([...color])
    expect((await appearance(label)).contrast).toBeGreaterThanOrEqual(4.5)
    await trigger.hover()
    await trigger.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    expect((await appearance(label)).contrast).toBeGreaterThanOrEqual(4.5)
    await trigger.focus()
    await page.keyboard.press("Enter")
    const rows = page.locator('[data-slot="list-item"]')
    await rows.last().waitFor()
    const menuIcon = '[data-slot="list-item"] .text-text-permission-full-access'
    await page.mouse.move(0, 0)
    await trigger.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    expect((await appearance(label)).contrast).toBeGreaterThanOrEqual(4.5)
    expect((await appearance(menuIcon)).color).toEqual([...color])
    expect((await appearance(menuIcon)).contrast).toBeGreaterThanOrEqual(3)
    await rows.last().hover()
    await rows.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    expect((await appearance(menuIcon)).contrast).toBeGreaterThanOrEqual(3)
    for (const [index, token] of [
      [0, "text-on-success-base"],
      [1, "text-interactive-base"],
    ] as const) {
      const colors = await rows
        .nth(index)
        .locator(`[data-slot="icon-svg"].text-${token}`)
        .evaluate((element, name) => {
          const reference = document.createElement("span")
          reference.style.color = `var(--${name})`
          document.body.append(reference)
          const expected = getComputedStyle(reference).color
          reference.remove()
          return { actual: getComputedStyle(element).color, expected }
        }, token)
      expect(colors.actual).toBe(colors.expected)
    }
    await page.keyboard.press("Escape")
    await rows.last().waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.classList.contains("prompt-input-toolbar-button"))
    expect(await trigger.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid")
    expect(errors).toEqual([])
    if (process.env.SYNERGY_VISUAL_OUTPUT) {
      await trigger.click()
      await rows.last().waitFor()
      await page.mouse.move(0, 0)
      await trigger.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      await page.screenshot({
        path: path.join(process.env.SYNERGY_VISUAL_OUTPUT, `full-access-${scheme.toLowerCase()}.png`),
      })
      await page.keyboard.press("Escape")
      await rows.last().waitFor({ state: "detached" })
    }
    for (const [index, token] of [
      [0, "text-on-success-base"],
      [1, "text-interactive-base"],
    ] as const) {
      await trigger.click()
      await rows.nth(index).click()
      await rows.last().waitFor({ state: "detached" })
      expect(await trigger.locator(`span.text-${token}`).count()).toBe(1)
      expect(await trigger.locator(`[data-slot="icon-svg"].text-${token}`).count()).toBe(1)
      expect(
        await trigger.evaluate((element) => element.classList.contains("prompt-input-permission-full-access")),
      ).toBe(false)
    }
  }, 30_000)
}

test("same-mode skin changes repaint mounted trigger and menu without replacing the trigger", async () => {
  await page.getByRole("button", { name: "Light", exact: true }).click()
  const trigger = page.locator(".prompt-input-toolbar-button")
  const initial = await trigger.elementHandle()
  await trigger.click()
  await page.locator('[data-slot="list-item"]').last().waitFor()
  await page.getByRole("button", { name: "Alternate skin" }).evaluate((element) => {
    if (element instanceof HTMLButtonElement) element.click()
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === "catppuccin")
  expect(await trigger.evaluate((element, original) => element === original, initial)).toBe(true)
  expect((await appearance(".prompt-input-toolbar-button > span")).color).not.toEqual([196, 72, 28])
  const menuIcon = '[data-slot="list-item"] .text-text-permission-full-access'
  expect((await appearance(menuIcon)).color).toEqual((await appearance(".prompt-input-toolbar-button > span")).color)
  await page.getByRole("button", { name: "Synergy skin" }).evaluate((element) => {
    if (element instanceof HTMLButtonElement) element.click()
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === "synergy")
  expect((await appearance(".prompt-input-toolbar-button > span")).color).toEqual([196, 72, 28])
  expect((await appearance(menuIcon)).color).toEqual([196, 72, 28])
  expect(errors).toEqual([])
})

test("permission selector remains reachable at 375px and preserves switching feedback", async () => {
  await page.setViewportSize({ width: 375, height: 650 })
  const trigger = page.locator(".prompt-input-toolbar-button")
  const bounds = await trigger.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Permission mode", exact: true })
  await dialog.waitFor()
  const menu = await dialog.boundingBox()
  expect(menu!.x).toBeGreaterThanOrEqual(0)
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(375)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Toggle switching" }).click()
  expect(await trigger.isDisabled()).toBe(true)
  expect(await trigger.locator('[data-component="spinner"]').count()).toBe(1)
  expect(errors).toEqual([])
})
