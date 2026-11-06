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
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { MetaProvider } from "@solidjs/meta"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { ViewActivityProvider } from "@ericsanchezok/synergy-ui/context/view-activity"
    import { useConfirm } from ${JSON.stringify(`/@fs/${source}/components/dialog/confirm-dialog.tsx`)}
    import { fullAccessConfirm } from ${JSON.stringify(`/@fs/${source}/components/dialog/full-access-confirm.ts`)}
    import { PermissionModeSelector } from ${JSON.stringify(`/@fs/${source}/components/prompt-input/permission-selector.tsx`)}
    import { permissionModeVisual } from ${JSON.stringify(`/@fs/${source}/components/prompt-input/permission-modes.ts`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    function Fixture() {
      const theme = useTheme()
      const confirm = useConfirm()
      const deferred = new URLSearchParams(location.search).has("deferred")
      const realConfirm = new URLSearchParams(location.search).has("confirm")
      const [profile, setProfile] = createSignal(deferred ? "guarded" : "full_access")
      const [switching, setSwitching] = createSignal(false)
      const [requests, setRequests] = createSignal(0)
      const [stage, setStage] = createSignal("idle")
      const [active, setActive] = createSignal(true)
      let acknowledge: (accepted: boolean) => void
      let save: (accepted: boolean) => void
      async function updateProfile(value, close) {
        setRequests(count => count + 1)
        if (deferred) {
          setStage("acknowledgement")
          const accepted = realConfirm ? await confirm.ask(fullAccessConfirm()) : await new Promise<boolean>(resolve => { acknowledge = resolve })
          if (!accepted) { setStage("rejected"); return }
          setSwitching(true)
          setStage("saving")
          const saved = await new Promise<boolean>(resolve => { save = resolve })
          setSwitching(false)
          if (!saved) { setStage("failed"); return }
        }
        setProfile(value)
        close?.()
        setStage("saved")
      }
      return <div class="synergy-workbench-canvas" style="min-height:100dvh;padding:24px;background:var(--background-stronger)">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <button onClick={() => theme.setColorScheme("light")}>Light</button>
          <button onClick={() => theme.setColorScheme("dark")}>Dark</button>
          <button onClick={() => theme.setThemeId("synergy")}>Synergy skin</button>
          <button onClick={() => theme.setThemeId("catppuccin")}>Alternate skin</button>
          <button onClick={() => setSwitching(!switching())}>Toggle switching</button>
          <Show when={deferred}>
            <button onClick={() => acknowledge?.(false)}>Reject acknowledgement</button>
            <button onClick={() => acknowledge?.(true)}>Accept acknowledgement</button>
            <button onClick={() => save?.(false)}>Fail save</button>
            <button onClick={() => save?.(true)}>Complete save</button>
            <button onClick={() => setActive(false)}>Hide selector</button>
            <button onClick={() => setActive(true)}>Show selector</button>
          </Show>
        </div>
        <div class="prompt-input-shell" style="margin-top:320px;max-width:600px">
          <div class="prompt-input-toolbar flex items-center">
            <ViewActivityProvider active={active}>
              <PermissionModeSelector switching={switching} selectedProfile={profile} activeMode={() => permissionModeVisual(profile())}
                updateProfile={updateProfile} />
            </ViewActivityProvider>
          </div>
        </div>
        <output aria-label="Saved profile">{profile()}</output>
        <output aria-label="Profile requests">{requests()}</output>
        <output aria-label="Update stage">{stage()}</output>
      </div>
    }
    render(() => <MetaProvider><Font /><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><ThemeProvider><DialogProvider><Fixture /></DialogProvider></ThemeProvider></I18nProvider></MetaProvider>, document.getElementById("root"))
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
  page.setDefaultTimeout(5000)
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
    const restingBackground = await trigger.evaluate((element) => getComputedStyle(element).backgroundImage)
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
    const rows = page.getByRole("option")
    await rows.last().waitFor()
    expect((await page.getByRole("dialog").boundingBox())!.width).toBeLessThanOrEqual(320)
    const menuIcon = '[role="option"] .text-text-permission-full-access'
    await page.mouse.move(0, 0)
    await trigger.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    expect((await appearance(label)).contrast).toBeGreaterThanOrEqual(4.5)
    expect((await appearance(menuIcon)).color).toEqual([...color])
    expect((await appearance(menuIcon)).contrast).toBeGreaterThanOrEqual(3)
    await rows.first().hover()
    expect(await rows.last().getAttribute("aria-selected")).toBe("true")
    expect(await rows.last().locator('[data-slot="menu-field-indicator"]').count()).toBe(1)
    expect(await rows.last().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
    expect(await rows.first().evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    )
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
    expect(await trigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    expect(await trigger.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe(restingBackground)
    expect(await trigger.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none")
    expect(await trigger.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none")
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
  await page.getByRole("option").last().waitFor()
  await page.getByRole("button", { name: "Alternate skin" }).evaluate((element) => {
    if (element instanceof HTMLButtonElement) element.click()
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === "catppuccin")
  expect(await trigger.evaluate((element, original) => element === original, initial)).toBe(true)
  expect((await appearance(".prompt-input-toolbar-button > span")).color).not.toEqual([196, 72, 28])
  const menuIcon = '[role="option"] .text-text-permission-full-access'
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
  expect(menu!.y + menu!.height).toBeLessThanOrEqual(bounds!.y)
  if (process.env.SYNERGY_VISUAL_OUTPUT) {
    await page.screenshot({ path: path.join(process.env.SYNERGY_VISUAL_OUTPUT, "permission-375px.png") })
  }
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Toggle switching" }).click()
  expect(await trigger.isDisabled()).toBe(true)
  expect(await trigger.locator('[data-component="spinner"]').count()).toBe(1)
  expect(errors).toEqual([])
})

test("permission selection waits for acceptance, stays open on rejection or failure, and disables pending choices", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?deferred`)
  const trigger = page.getByRole("button", { name: "Guarded permission mode", exact: true })
  const listbox = page.getByRole("listbox", { name: "Permission mode", exact: true })
  const guarded = page.getByRole("option", { name: /^Guarded/ })
  const fullAccess = page.getByRole("option", { name: /^Full Access/ })
  const settle = async (name: string, stage: string) => {
    await page.getByRole("button", { name, exact: true }).evaluate((element) => (element as HTMLButtonElement).click())
    await page.waitForFunction(
      (expected) => document.querySelector('[aria-label="Update stage"]')?.textContent === expected,
      stage,
    )
  }
  await trigger.click()
  await fullAccess.click()
  await settle("Reject acknowledgement", "rejected")
  expect(await listbox.isVisible()).toBe(true)
  expect(await guarded.getAttribute("aria-selected")).toBe("true")
  expect(await fullAccess.getAttribute("aria-selected")).toBe("false")
  expect(await page.getByLabel("Saved profile").textContent()).toBe("guarded")

  await fullAccess.click()
  await settle("Accept acknowledgement", "saving")
  expect(await trigger.isDisabled()).toBe(true)
  expect(await trigger.locator('[data-component="spinner"]').count()).toBe(1)
  expect(await listbox.locator('[role="option"][aria-disabled="true"]').count()).toBe(3)
  expect(await guarded.getAttribute("aria-selected")).toBe("true")
  expect(await fullAccess.getAttribute("aria-selected")).toBe("false")
  await page.getByRole("option", { name: /^Autonomous/ }).evaluate((element) => (element as HTMLElement).click())
  await page.keyboard.press("Enter")
  expect(await page.getByLabel("Profile requests").textContent()).toBe("2")
  await settle("Fail save", "failed")
  expect(await listbox.isVisible()).toBe(true)
  expect(await trigger.isEnabled()).toBe(true)
  expect(await guarded.getAttribute("aria-selected")).toBe("true")
  expect(await page.getByLabel("Saved profile").textContent()).toBe("guarded")

  await fullAccess.click()
  await settle("Accept acknowledgement", "saving")
  await settle("Complete save", "saved")
  await listbox.waitFor({ state: "detached" })
  expect(await page.getByLabel("Saved profile").textContent()).toBe("full_access")
  const fullTrigger = page.getByRole("button", { name: "Full Access permission mode", exact: true })
  await fullTrigger.press("ArrowUp")
  await fullAccess.click()
  await listbox.waitFor({ state: "detached" })
  expect(await page.getByLabel("Profile requests").textContent()).toBe("3")
  expect(errors).toEqual([])
}, 30_000)

test("the real Full Access confirmation keeps the menu unchanged until the owner commits", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?deferred&confirm`)
  const trigger = page.getByRole("button", { name: "Guarded permission mode", exact: true })
  await trigger.click()
  await page.getByRole("option", { name: /^Full Access/ }).click()
  const confirmation = page.getByRole("dialog", { name: "Enable Full Access?", exact: true })
  await confirmation.waitFor()
  await confirmation.getByRole("button", { name: "Keep current mode", exact: true }).click()
  await confirmation.waitFor({ state: "detached" })
  await page.getByRole("listbox", { name: "Permission mode", exact: true }).waitFor()
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  expect(await page.getByRole("option", { name: /^Guarded/ }).getAttribute("aria-selected")).toBe("true")
  expect(await page.getByLabel("Saved profile").textContent()).toBe("guarded")
  expect(await page.getByLabel("Update stage").textContent()).toBe("rejected")
  await page.keyboard.press("Escape")
  await page.getByRole("listbox", { name: "Permission mode", exact: true }).waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Guarded permission mode")
  expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)

  await trigger.click()
  await page.getByRole("option", { name: /^Full Access/ }).click()
  await confirmation.getByRole("button", { name: "Enable Full Access", exact: true }).click()
  await confirmation.waitFor({ state: "detached" })
  expect(await page.getByRole("listbox", { name: "Permission mode", exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("option", { name: /^Guarded/ }).getAttribute("aria-selected")).toBe("true")
  expect(await trigger.isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Complete save", exact: true }).click()
  await page.getByRole("listbox", { name: "Permission mode", exact: true }).waitFor({ state: "detached" })
  expect(await page.getByLabel("Saved profile").textContent()).toBe("full_access")
  expect(await page.getByLabel("Update stage").textContent()).toBe("saved")
  expect(errors).toEqual([])
}, 30_000)

test("hiding the view dismisses a pending permission menu without reopening it on return", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?deferred`)
  const trigger = page.getByRole("button", { name: "Guarded permission mode", exact: true })
  const listbox = page.getByRole("listbox", { name: "Permission mode", exact: true })
  await trigger.click()
  await page.getByRole("option", { name: /^Full Access/ }).click()
  expect(await trigger.isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Hide selector", exact: true }).click()
  await listbox.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Show selector", exact: true }).click()
  expect(await listbox.count()).toBe(0)
  await page.getByRole("button", { name: "Reject acknowledgement", exact: true }).click()
  expect(await trigger.isEnabled()).toBe(true)
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  expect(await page.getByLabel("Saved profile").textContent()).toBe("guarded")
  expect(errors).toEqual([])
}, 30_000)
