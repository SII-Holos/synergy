import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

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
  const fileStubPath = path.join(fixtureDirectory, "file-stub.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#root{display:flex;height:100vh}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      fileStubPath,
      `
        import { createContext, useContext } from "solid-js"
        import { createStore } from "solid-js/store"

        const folders = location.search.includes("folders") ? [
          { id: "wsp_primary", generation: 1, scopeID: "scope", type: "directory", path: "/workspace/a-very-long-project-directory/primary" },
          { id: "wsp_secondary", generation: 1, scopeID: "scope", type: "directory", path: "/workspace/secondary" },
        ] : []
        const WorkspaceContext = createContext()

        // Deterministic in-memory tree shaped like the real Synergy
        // file-explorer model: loadChildren("docs") populates the child
        // rows; without that call the persisted expansion state stays
        // true but the subtree renders nothing.
        const [store, setStore] = createStore({
          expanded: location.search.includes("collapsed") ? [] : ["docs"],
          directories: {},
          nodes: {},
        })

        const tree = {
          "": [{ path: "docs", name: "docs", type: "directory" }],
          docs: [
            { path: "docs/api.md", name: "api.md", type: "file" },
            { path: "docs/guide.md", name: "guide.md", type: "file" },
            { path: "docs/nested", name: "nested", type: "directory" },
          ],
          "docs/nested": [{ path: "docs/nested/deep.txt", name: "deep.txt", type: "file" }],
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

        async function loadChildren(path, workspace) {
          const items = workspace?.id === "wsp_secondary"
            ? (path === "" ? [{ path: "secondary.txt", name: "secondary.txt", type: "file" }] : [])
            : tree[path] ?? []
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

        export const FileWorkspaceProvider = (props) => <WorkspaceContext.Provider value={props.workspace}>{props.children}</WorkspaceContext.Provider>
        export const useProjectFiles = () => ({ roots: () => folders, search: async () => [], open: async () => {} })
        export const useFile = () => {
          const workspace = useContext(WorkspaceContext)
          const load = (path) => loadChildren(path, workspace)
          return {
          workspace,
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
            expandingAll: () => false,
            expandAll: async () => {
              setStore("expanded", ["docs", "docs/nested"])
              for (const path of ["", "docs", "docs/nested"]) await load(path)
            },
            isExpanded,
            setExpanded: (path, expanded) => {
              setStore("expanded", (items) =>
                expanded ? (items.includes(path) ? items : [...items, path]) : items.filter((item) => item !== path),
              )
              if (expanded) void load(path)
            },
            collapseAll: () => setStore("expanded", []),
            node,
            directory,
            loadChildren: load,
            reveal: async () => {},
            refresh: async () => {},
          },
          searchFiles: async () => ({ items: [] }),
        }}
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
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { MetaProvider } from "@solidjs/meta"
        import { Font } from "@ericsanchezok/synergy-ui/font"
        import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
        import { FileExplorer } from ${JSON.stringify(`/@fs/${explorerPath}`)}
        import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
        import ${JSON.stringify(`/@fs/${appSrc}/components/file-workbench/styles.css`)}

        const i18n = setupI18n({ locale: "en" })
        render(
          () => <MetaProvider><Font/><ThemeProvider><I18nProvider i18n={i18n}><DialogProvider><FileExplorer onClose={() => {}} /></DialogProvider></I18nProvider></ThemeProvider></MetaProvider>,
          document.querySelector("#root"),
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin(), tailwind()],
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
  page.setDefaultTimeout(4000)
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
    expect(await rows.count()).toBe(4)
    expect(await page.locator('[data-path="docs"]').getAttribute("aria-expanded")).toBe("true")
    expect(await page.locator('[data-path="docs/api.md"]').isVisible()).toBe(true)
    expect(await page.locator('[data-path="docs/guide.md"]').isVisible()).toBe(true)
  }, 60000)

  test("folder menu exposes full directory choices and switches the visible Workspace by keyboard", async () => {
    await page.setViewportSize({ width: 375, height: 600 })
    await page.goto(`${baseUrl}?folders`)
    const primary = "/workspace/a-very-long-project-directory/primary"
    const trigger = page.getByRole("button", { name: `Folders: ${primary}`, exact: true })
    await trigger.click()
    const listbox = page.getByRole("listbox", { name: "Folders", exact: true })
    await listbox.waitFor()
    expect(await listbox.getByRole("option").count()).toBe(2)
    const primaryOption = listbox.getByRole("option", { name: primary, exact: true })
    expect(await primaryOption.getAttribute("aria-selected")).toBe("true")
    const colors: string[] = []
    await page.locator(".menu-field-surface").evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      await document.fonts.ready
    })
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
      const appearance = await page.locator(".menu-field-surface").evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          background: getComputedStyle(element).backgroundColor,
          fits: bounds.x >= 0 && bounds.right <= innerWidth && bounds.y >= 0 && bounds.bottom <= innerHeight,
        }
      })
      expect(appearance.fits).toBe(true)
      colors.push(appearance.background)
    }
    expect(colors[0]).not.toBe(colors[1])
    const secondary = listbox.getByRole("option", { name: "/workspace/secondary", exact: true })
    await page.waitForFunction((element) => document.activeElement === element, await primaryOption.elementHandle())
    await page.keyboard.press("ArrowDown")
    expect(await secondary.getAttribute("data-highlighted")).toBe("")
    await page.keyboard.press("Escape")
    await listbox.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Folders:"))
    expect(await trigger.isVisible()).toBe(true)
    await trigger.press("ArrowDown")
    await page.waitForFunction((element) => document.activeElement === element, await primaryOption.elementHandle())
    await page.keyboard.press("ArrowDown")
    expect(await secondary.getAttribute("data-highlighted")).toBe("")
    await page.waitForFunction((element) => document.activeElement === element, await secondary.elementHandle())
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Folders: /workspace/secondary", exact: true }).waitFor()
    await page.locator('[data-path="secondary.txt"]').waitFor()
    expect(await page.locator('[data-path="docs"]').count()).toBe(0)
    expect(pageErrors).toEqual([])
  }, 30000)

  test("the review-style fold button toggles every folder without adding a tooltip", async () => {
    await page.setViewportSize({ width: 375, height: 350 })
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto(`${baseUrl}?collapsed`)
    await page.getByRole("treeitem").waitFor()
    const expand = page.getByRole("button", { name: "Expand all folders", exact: true })
    await expand.focus()
    await expand.press("Enter")
    await page.locator('[data-path="docs/nested/deep.txt"]').waitFor()
    expect(await page.locator('[data-path="docs/nested"]').getAttribute("aria-expanded")).toBe("true")
    const collapse = page.getByRole("button", { name: "Collapse all folders", exact: true })
    expect(await collapse.getAttribute("aria-describedby")).toBeNull()
    await collapse.click()
    expect(await page.getByRole("treeitem").count()).toBe(1)
    expect(await page.locator('[data-path="docs"]').getAttribute("aria-expanded")).toBe("false")
    await expand.click()
    await page.locator('[data-path="docs/nested/deep.txt"]').waitFor()
    expect(await page.getByRole("tooltip").count()).toBe(0)
    expect(pageErrors).toEqual([])
  }, 30000)
})
