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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".html-preview-fixture-"))
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
          get: () => ({
            loading: false,
            stale: false,
            deleted: false,
            content: { kind: "text", content: "<p>source</p>" },
            version: { mtime: 1725000000, size: 128 },
          }),
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
          openLink: () => {},
        })
      `,
    ),
    // Simulates bun dev: the SDK base points at the server port (:4096) while
    // the app page is served from the Vite dev server. The preview iframe must
    // fall back to the app origin so X-Frame-Options: SAMEORIGIN passes.
    Bun.write(
      sdkStubPath,
      `export const useSDK = () => ({ url: "http://127.0.0.1:4096", scopeID: "home", directory: undefined })`,
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
    plugins: [
      solidPlugin(),
      {
        name: "raw-file-fixture",
        // Simulates the backend /workspace/files/raw route (same headers the
        // real server sends: XFO SAMEORIGIN + sandbox CSP) on the same origin
        // as the Vite app, standing in for the /workspace dev proxy.
        configureServer(devServer) {
          devServer.middlewares.use("/workspace/files/raw/", (_req, res) => {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "x-frame-options": "SAMEORIGIN",
              "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
            })
            res.end('<!doctype html><html><body><p id="doc">rendered</p></body></html>')
          })
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^@\/context\/file$/, replacement: fileStubPath },
        { find: /^@\/context\/prompt$/, replacement: promptStubPath },
        { find: /^@\/context\/platform$/, replacement: platformStubPath },
        { find: /^@\/context\/sdk$/, replacement: sdkStubPath },
        { find: /^@\/context\/locale$/, replacement: localeStubPath },
        { find: "@lingui/solid", replacement: path.join(fixtureDirectory, "lingui-stub.tsx") },
        { find: "@lingui/core", replacement: path.join(fixtureDirectory, "lingui-core-stub.ts") },
        {
          find: "@ericsanchezok/synergy-plugin/theme",
          replacement: path.resolve(import.meta.dir, "../../../../..", "packages/plugin/src/theme/index.ts"),
        },
        { find: "@", replacement: appSrc },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "zod"],
      noDiscovery: true,
    },
    cacheDir: path.join(fixtureDirectory, ".vite"),
    server: {
      host: "127.0.0.1",
      port: 5217,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
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
  try {
    await page.goto(`${baseUrl}?path=test.html`)
    await page.waitForSelector(".file-html-preview", { timeout: 30000 })
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

describe("file workbench HTML preview iframe", () => {
  test("points the iframe at the app origin even when the SDK base is cross-origin", async () => {
    const src = await page.locator(".file-html-preview").getAttribute("src")
    const appOrigin = new URL(baseUrl).origin
    expect(src).toMatch(new RegExp(`^${appOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspace/files/raw/`))
    expect(src).not.toContain("127.0.0.1:4096")
  })

  test("keeps the sandbox attribute so the document stays confined", async () => {
    const sandbox = await page.locator(".file-html-preview").getAttribute("sandbox")
    expect(sandbox).toBe("allow-scripts")
  })

  test("loads the sandboxed document inside the same-origin frame", async () => {
    const doc = page.frameLocator(".file-html-preview").locator("#doc")
    await doc.waitFor({ state: "attached", timeout: 30000 })
    // The document is sandboxed into an opaque origin (no allow-same-origin),
    // so the parent cannot read contentDocument; frameLocator queries the
    // frame DOM directly. The text is static, so attached implies rendered.
    expect(await doc.textContent()).toBe("rendered")
  }, 60000)
})
