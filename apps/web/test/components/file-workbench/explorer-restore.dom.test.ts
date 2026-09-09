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

const explorerPath = path.resolve(import.meta.dir, "../../../src/components/file-workbench/explorer.tsx")
const appSrc = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".explorer-restore-fixture-"))
  const fileStubPath = path.join(fixtureDirectory, "file-stub.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      fileStubPath,
      `
        import { createStore } from "solid-js/store"

        // Deterministic in-memory tree shaped like the real Synergy
        // file-explorer model: loadChildren("docs") populates the child
        // rows; without that call the persisted expansion state stays
        // true but the subtree renders nothing.
        const [store, setStore] = createStore({
          expanded: ["docs"],
          directories: {},
          nodes: {},
        })

        const tree = {
          "": [{ path: "docs", name: "docs", type: "directory" }],
          docs: [
            { path: "docs/api.md", name: "api.md", type: "file" },
            { path: "docs/guide.md", name: "guide.md", type: "file" },
          ],
        }

        function directory(path) {
          return store.directories[path]
        }

        function node(path) {
          return store.nodes[path]
        }

        function isExpanded(path) {
          return store.expanded.includes(path)
        }

        async function loadChildren(path) {
          const items = tree[path] ?? []
          setStore("directories", path, {
            items: items.map((item) => item.path),
            nextCursor: undefined,
            complete: true,
            loading: false,
            stale: false,
            error: undefined,
            generation: 1,
          })
          for (const item of items) {
            setStore("nodes", item.path, item)
          }
        }

        export const useFile = () => ({
          activePath: () => undefined,
          get: () => undefined,
          openWorkspaceFile: async () => {},
          explorer: {
            open: () => true,
            setOpen: () => {},
            width: () => 296,
            setWidth: () => {},
            showHidden: () => false,
            setShowHidden: () => {},
            expanded: () => store.expanded,
            isExpanded,
            setExpanded: (path, expanded) => {
              setStore("expanded", (items) =>
                expanded ? (items.includes(path) ? items : [...items, path]) : items.filter((item) => item !== path),
              )
              if (expanded) void loadChildren(path)
            },
            collapseAll: () => setStore("expanded", []),
            node,
            directory,
            loadChildren,
            reveal: async () => {},
            refresh: async () => {},
          },
          searchFiles: async () => ({ items: [] }),
        })
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "lingui-stub.tsx"),
      `
        import type { JSX } from "solid-js"
        // Minimal Lingui stand-in; see open-in-browser.dom.test.ts for why.
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
        import { FileExplorer } from ${JSON.stringify(`/@fs/${explorerPath}`)}

        const i18n = setupI18n({ locale: "en" })
        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              children: () =>
                createComponent(FileExplorer, {
                  onClose: () => {},
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
  page = await browser.newPage({ viewport: { width: 420, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(error))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(new Error(message.text()))
  })
  page.on("response", (response) => {
    if (response.status() >= 400) pageErrors.push(new Error(`HTTP ${response.status()} for ${response.url()}`))
  })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("file explorer expanded-state restore", () => {
  test("restores expanded directory children on mount when expansion state is persisted", async () => {
    await page.goto(baseUrl)

    // The stub keeps `expanded` = ["docs"] but starts with an empty tree
    // (mirroring a session switch where the in-memory node cache was dropped
    // while localStorage kept the expansion list). The explorer must relist
    // the persisted folders' children so the subtree renders collapsed-open.
    await page.waitForSelector('[role="tree"]', { timeout: 30000 })

    const rows = page.locator('[role="treeitem"]')
    expect(await rows.count()).toBe(3)
    expect(await page.locator('[data-path="docs"]').getAttribute("aria-expanded")).toBe("true")
    expect(await page.locator('[data-path="docs/api.md"]').isVisible()).toBe(true)
    expect(await page.locator('[data-path="docs/guide.md"]').isVisible()).toBe(true)
  }, 60000)
})
