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
        import { setupI18n } from "@lingui/core"
        const i18n = setupI18n({ locale: "en" })
        export const useLocale = () => ({ i18n, fmt: { number: (value) => String(value) } })
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
        { find: "@", replacement: appSrc },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5216,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()

  const resolved = server.resolvedUrls?.local[0]
  if (!resolved) throw new Error("Expected Vite test server URL")
  baseUrl = resolved

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
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
