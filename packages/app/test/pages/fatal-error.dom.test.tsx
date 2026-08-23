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
let baseUrl: string

const componentPath = path.resolve(import.meta.dir, "../../src/pages/fatal-error.tsx")
const initErrorComponentPath = path.resolve(import.meta.dir, "../../src/pages/error.tsx")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".fatal-error-fixture-"))
  const localeStubPath = path.join(fixtureDirectory, "locale-stub.ts")
  const platformStubPath = path.join(fixtureDirectory, "platform-stub.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    // Minimal hermetic locale stub: Lingui interpolates ICU values on the
    // translated entry, so the rendered "Version: {version}" copy is
    // observable in the DOM.
    Bun.write(
      localeStubPath,
      `
        import { setupI18n } from "@lingui/core"
        const i18n = setupI18n({
          locale: "en",
          messages: { en: { "app.error.versionLabel": "Version: {version}" } },
        })
        export const useLocale = () => ({ i18n })
      `,
    ),
    Bun.write(
      platformStubPath,
      `
        export const usePlatform = () => {
          const build = new URLSearchParams(location.search).get("build")
          return {
            platform: "web",
            version: "9.9.9-test",
            buildLabel: build ?? undefined,
            openLink: () => {},
            restart: async () => {},
          }
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { FatalErrorPage } from ${JSON.stringify(`/@fs/${componentPath}`)}
        import { ErrorPage } from ${JSON.stringify(`/@fs/${initErrorComponentPath}`)}

        const component =
          new URLSearchParams(location.search).get("page") === "init" ? ErrorPage : FatalErrorPage

        render(
          () =>
            createComponent(component, {
              error: new Error("Version rendering probe"),
            }),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@/context/locale": localeStubPath,
        "@/context/platform": platformStubPath,
        "@": path.resolve(import.meta.dir, "../../src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5214,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  baseUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("fatal error page version footer", () => {
  test("renders the platform version string, not the Show accessor", async () => {
    await page.goto(baseUrl)
    const versionLine = page.locator("p.text-xs")
    await expect(versionLine.count()).resolves.toBe(1)
    await expect(versionLine.textContent()).resolves.toBe("Version: 9.9.9-test")
  })

  test("prefers the build label over the version when present", async () => {
    await page.goto(`${baseUrl}?build=1.1.26%2Babc123`)
    const versionLine = page.locator("p.text-xs")
    await expect(versionLine.count()).resolves.toBe(1)
    await expect(versionLine.textContent()).resolves.toBe("Version: 1.1.26+abc123")
  })

  test("init error page renders the version string too", async () => {
    await page.goto(`${baseUrl}?page=init`)
    const versionLine = page.locator("p.text-xs")
    await expect(versionLine.count()).resolves.toBe(1)
    await expect(versionLine.textContent()).resolves.toBe("Version: 9.9.9-test")
  })
})
