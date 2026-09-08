import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
const pageErrors: Error[] = []

const componentPath = path.resolve(import.meta.dir, "../../../../src/components/settings/components/ThemePicker.tsx")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".theme-picker-fixture-"))
  const componentImport = JSON.stringify(`/@fs/${componentPath}`)

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { builtinThemes } from "@ericsanchezok/synergy-ui/theme"
        import { ThemePicker } from ${componentImport}

        const themes = builtinThemes.map((theme) => ({
          id: theme.id,
          label: theme.name,
          theme,
          builtin: true,
        }))

        function Harness() {
          const [value, setValue] = createSignal("synergy")
          return createComponent(ThemePicker, {
            ariaLabel: "Appearance theme",
            mode: "light",
            themes,
            get value() {
              return value()
            },
            onChange: (id: string) => setValue(id),
          })
        }

        render(() => createComponent(Harness, {}), document.querySelector("#root")!)
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        // The plugin package's exports map serves "import" from its gitignored
        // dist/theme/index.js, which is absent in the Coverage job (it runs no
        // build step; turbo test only builds it through dependsOn ^build).
        // Resolve the theme entry to source so the fixture is hermetic on any
        // fresh checkout.
        "@ericsanchezok/synergy-plugin/theme": path.resolve(
          import.meta.dir,
          "../../../../../..",
          "packages/plugin/src/theme/index.ts",
        ),
      },
    },
    // Pre-bundle the Solid runtime, JSX runtime, and zod (pulled in through
    // builtinThemes -> resolveTheme) at server startup. With noDiscovery the
    // optimizer never re-runs after the first request, so a dependency found
    // mid-load cannot invalidate the bundle and reload the page mid-flight
    // (which returned 500 on slow cold Coverage CI starts). The cache is
    // scoped to this fixture because the sibling Playwright servers share
    // packages/app/node_modules/.vite and invalidate each other's cache.
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "zod"],
      noDiscovery: true,
    },
    cacheDir: path.join(fixtureDirectory, ".vite"),
    server: {
      host: "127.0.0.1",
      port: 5206,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  // Transform the whole fixture module graph server-side before the browser
  // connects: dependency optimization is finalized up front and any transform
  // error surfaces here with its real message instead of a browser 500.
  await server.warmupRequest("/main.tsx")

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(error))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(new Error(message.text()))
  })
  page.on("response", (response) => {
    if (response.status() >= 400) pageErrors.push(new Error(`HTTP ${response.status()} for ${response.url()}`))
  })
  await page.goto(url)
  try {
    await page.waitForSelector('[role="radio"]', { timeout: 60000 })
  } catch (error) {
    const pageError = pageErrors[0]
    if (pageError) throw new Error(`ThemePicker fixture page failed to render: ${pageError.stack}`, { cause: error })
    throw error
  }
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

const radios = () => page.locator('[role="radio"]')
const checkedLabel = async () =>
  (await page.locator('[role="radio"][aria-checked="true"]').first().getAttribute("aria-label")) ?? null
const focusedLabel = async () => (await page.locator('[role="radio"]:focus').first().getAttribute("aria-label")) ?? null

describe("ThemePicker behavior", () => {
  test("renders one radio card per built-in theme and marks the selected one", async () => {
    await expect(radios().count()).resolves.toBe(8)
    expect(await checkedLabel()).toBe("Synergy")
  })

  test("clicking a card reports onChange and moves the checked state", async () => {
    await page.locator('[role="radio"][aria-label="Ayu"]').click()
    expect(await checkedLabel()).toBe("Ayu")
  })

  test("arrow keys move focus and select the next card (roving tabindex)", async () => {
    await page.locator('[role="radio"][aria-label="Synergy"]').focus()
    await page.keyboard.press("ArrowRight")
    expect(await focusedLabel()).toBe("Catppuccin")
    expect(await checkedLabel()).toBe("Catppuccin")

    await page.keyboard.press("ArrowRight")
    expect(await focusedLabel()).toBe("Tokyo Night")

    await page.keyboard.press("Home")
    expect(await focusedLabel()).toBe("Synergy")
  })
})
