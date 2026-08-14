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

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".provider-icon-fixture-"))
  const iconPath = path.resolve(import.meta.dir, "../../src/components/provider-icon.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { ProviderIcon } from ${JSON.stringify(`/@fs/${iconPath}`)}

        const [id, setId] = createSignal("deepseek")
        render(
          () =>
            createComponent(ProviderIcon, {
              get id() {
                return id()
              },
            }),
          document.querySelector("#root"),
        )
        ;(window as any).__setProviderIconID = setId
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [path.resolve(import.meta.dir, "../../..")] },
    },
    // This suite runs in the main parallel batch next to tooltip; both
    // share packages/ui/node_modules/.vite by default, so concurrent
    // dependency optimization corrupts the shared cache. Give each suite its
    // own stable cache directory under the fixture root.
    cacheDir: path.join(fixtureDirectory, ".vite-cache"),
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  // Warm up dependency optimization and module transforms before launching the
  // browser so the first navigation does not pay for Vite re-optimization
  // inside Playwright's goto budget (CI cold starts exceeded 30s).
  await server.transformRequest("/main.ts")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("ProviderIcon", () => {
  test("updates the sprite href when the provider id changes", async () => {
    const icon = page.locator("svg[data-component='provider-icon'] use")
    expect(await icon.getAttribute("href")).toContain("#deepseek")

    await page.evaluate(() => (window as any).__setProviderIconID("openai"))
    expect(await icon.getAttribute("href")).toContain("#openai")
  })

  test("aliases grok to the xai sprite entry", async () => {
    await page.evaluate(() => (window as any).__setProviderIconID("grok"))
    expect(await page.locator("svg[data-component='provider-icon'] use").getAttribute("href")).toContain("#xai")
  })

  test("hides the icon for unknown provider ids", async () => {
    await page.evaluate(() => (window as any).__setProviderIconID("does-not-exist"))
    expect(await page.locator("svg[data-component='provider-icon']").count()).toBe(0)
  })
})
