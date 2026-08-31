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
const pageErrors: Error[] = []

const componentPath = path.resolve(import.meta.dir, "../../../src/components/file-workbench/content.tsx")
const appSrc = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".open-in-browser-fixture-"))
  const fileStubPath = path.join(fixtureDirectory, "file-stub.ts")
  const promptStubPath = path.join(fixtureDirectory, "prompt-stub.ts")
  const platformStubPath = path.join(fixtureDirectory, "platform-stub.ts")
  const sdkStubPath = path.join(fixtureDirectory, "sdk-stub.ts")
  const localeStubPath = path.join(fixtureDirectory, "locale-stub.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      fileStubPath,
      `
        export const useFile = () => ({
          get: () => ({ loading: true, content: undefined }),
          load: async () => {},
          save: async () => {},
          normalize: (value) => value,
          openWorkspaceFile: async () => {},
          view: {
            mode: () => undefined,
            setMode: () => {},
            selectedLines: () => undefined,
            imageScaleMode: () => "fit",
            setImageScaleMode: () => {},
          },
          pdf: { get: () => undefined, load: async () => {} },
          explorer: { open: () => false, setOpen: () => {}, reveal: async () => {} },
        })
      `,
    ),
    Bun.write(promptStubPath, `export const usePrompt = () => ({ context: { add: () => {} } })`),
    Bun.write(
      platformStubPath,
      `
        export const usePlatform = () => ({
          platform: "web",
          openLink: (url) => {
            window.__openedUrls = window.__openedUrls ?? []
            window.__openedUrls.push(url)
          },
        })
      `,
    ),
    Bun.write(
      sdkStubPath,
      `export const useSDK = () => ({ url: "http://127.0.0.1:4096", scopeID: undefined, directory: "/workspace/demo" })`,
    ),
    Bun.write(
      localeStubPath,
      `
        export const useLocale = () => ({ i18n: {}, fmt: { number: (value) => String(value) } })
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "lingui-stub.tsx"),
      `
        import type { JSX } from "solid-js"
        // Minimal Lingui stand-in: this fixture asserts workbench chrome and
        // click behavior, not i18n rendering. The real @lingui/solid runtime
        // pulls @messageformat/parser (CJS) through @lingui/message-utils,
        // whose named import breaks under Vite's dependency pre-bundling in
        // the Coverage job (no build step, shared .vite cache).
        export function I18nProvider(props: { children?: JSX.Element }) {
          return props.children
        }
        export function useLingui() {
          return {
            _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id,
          }
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "lingui-core-stub.ts"),
      `
        // Minimal @lingui/core stand-in; see lingui-stub.tsx for why.
        export function setupI18n() {
          return {}
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { FileWorkbenchContent } from ${JSON.stringify(`/@fs/${componentPath}`)}

        const i18n = setupI18n({ locale: "en" })
        const file = new URLSearchParams(location.search).get("path") ?? ""
        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              children: () =>
                createComponent(FileWorkbenchContent, {
                  tab: { id: "file", type: "file", title: file, resourceId: file },
                  onRequestClose: () => {},
                }),
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
    resolve: {
      alias: [
        { find: /^@\/context\/file$/, replacement: fileStubPath },
        { find: /^@\/context\/prompt$/, replacement: promptStubPath },
        { find: /^@\/context\/platform$/, replacement: platformStubPath },
        { find: /^@\/context\/sdk$/, replacement: sdkStubPath },
        { find: /^@\/context\/locale$/, replacement: localeStubPath },
        // The real Lingui runtime pulls @messageformat/parser (CJS) through
        // @lingui/message-utils; its named `parse` import breaks under Vite's
        // on-demand dependency optimization in the no-build Coverage job.
        // The fixture asserts workbench chrome and click behavior, not i18n
        // rendering, so both Lingui entries resolve to hermetic stubs.
        { find: "@lingui/solid", replacement: path.join(fixtureDirectory, "lingui-stub.tsx") },
        { find: "@lingui/core", replacement: path.join(fixtureDirectory, "lingui-core-stub.ts") },
        // The plugin package's exports map serves "import" from its
        // gitignored dist/theme/index.js, which a fresh checkout lacks (the
        // Coverage job runs no build step). Resolve the theme entry to source
        // so the fixture is hermetic on any checkout.
        {
          find: "@ericsanchezok/synergy-plugin/theme",
          replacement: path.resolve(import.meta.dir, "../../../../..", "packages/plugin/src/theme/index.ts"),
        },
        { find: "@", replacement: appSrc },
      ],
    },
    // Pre-bundle the Solid runtime, JSX runtime, and zod at server startup so
    // the optimizer never re-runs mid-load (which reloads the page and 500s
    // on slow cold Coverage CI starts). The cache is scoped to this fixture
    // because sibling Playwright servers share packages/app/node_modules/.vite
    // and invalidate each other's cache.
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "zod"],
      noDiscovery: true,
    },
    cacheDir: path.join(fixtureDirectory, ".vite"),
    server: {
      host: "127.0.0.1",
      port: 5216,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  // Transform the whole fixture module graph server-side before the browser
  // connects so transform errors surface here instead of a browser 500.
  await server.warmupRequest("/main.tsx")

  const resolved = server.resolvedUrls?.local[0]
  if (!resolved) throw new Error("Expected Vite test server URL")
  baseUrl = resolved

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(error))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(new Error(message.text()))
  })
  page.on("response", (response) => {
    if (response.status() >= 400) pageErrors.push(new Error(`HTTP ${response.status()} for ${response.url()}`))
  })
  // Smoke the fixture once before the cases run so a broken module graph
  // fails here with page errors attached instead of three 30s timeouts.
  try {
    await page.goto(`${baseUrl}?path=README.md`)
    await page.waitForSelector(".file-workbench-toolbar", { timeout: 30000 })
  } catch (error) {
    const pageError = pageErrors[0]
    if (pageError) throw new Error(`file workbench fixture page failed to render: ${pageError.stack}`, { cause: error })
    throw error
  }
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("file workbench open-in-browser action", () => {
  test("renders the toolbar button for an HTML file and opens the raw content URL", async () => {
    await page.goto(`${baseUrl}?path=docs%2Findex.html`)
    const button = page.getByRole("button", { name: "Open in browser" })
    await button.waitFor({ state: "visible", timeout: 30000 })
    await button.click()
    await page.waitForFunction(() => ((window as any).__openedUrls?.length ?? 0) > 0)
    const urls = await page.evaluate(() => (window as any).__openedUrls as string[])
    expect(urls).toEqual(["http://127.0.0.1:4096/workspace/files/raw/L3dvcmtzcGFjZS9kZW1v/docs/index.html"])
  }, 60000)

  test("treats .htm files as HTML too", async () => {
    await page.goto(`${baseUrl}?path=index.htm`)
    const button = page.getByRole("button", { name: "Open in browser" })
    await button.waitFor({ state: "visible", timeout: 30000 })
  }, 60000)

  test("hides the toolbar button for non-HTML files", async () => {
    await page.goto(`${baseUrl}?path=README.md`)
    await page.waitForSelector(".file-workbench-toolbar", { timeout: 30000 })
    await page.waitForTimeout(300)
    const count = await page.locator(".file-open-in-browser").count()
    expect(count).toBe(0)
  }, 60000)
})
