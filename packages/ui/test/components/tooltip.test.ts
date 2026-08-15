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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".tooltip-fixture-"))
  const tooltipPath = path.resolve(import.meta.dir, "../../src/components/tooltip.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { Tooltip } from ${JSON.stringify(`/@fs/${tooltipPath}`)}

        const button = document.createElement("button")
        button.textContent = "Trigger"
        render(
          () => createComponent(Tooltip, {
            value: "Tooltip content",
            placement: "top",
            openDelay: 0,
            closeDelay: 0,
            get children() {
              return button
            },
          }),
          document.querySelector("#root"),
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5200,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../..")] },
    },
    // This suite runs in the main parallel batch next to provider-icon; both
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

describe("Tooltip", () => {
  test("mounts portal content only while open", async () => {
    const trigger = page.getByRole("button", { name: "Trigger" })

    await expect(trigger.count()).resolves.toBe(1)
    expect(await page.getByRole("tooltip").count()).toBe(0)

    await trigger.hover()
    await page.getByRole("tooltip").waitFor({ state: "visible" })
    expect(await page.getByRole("tooltip").count()).toBe(1)

    await page.mouse.move(0, 0)
    await page.getByRole("tooltip").waitFor({ state: "detached" })
    expect(await page.getByRole("tooltip").count()).toBe(0)
  })
})
