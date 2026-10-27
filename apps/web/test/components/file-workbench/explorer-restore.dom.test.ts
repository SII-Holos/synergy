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
        import { createContext, useContext, createSignal } from "solid-js"
        import { createStore } from "solid-js/store"

        const folders = location.search.includes("folders") ? [
          { id: "wsp_primary", generation: 1, scopeID: "scope", type: "directory", path: "/workspace/a-very-long-project-directory/primary" },
          { id: "wsp_secondary", generation: 1, scopeID: "scope", type: "directory", path: "/workspace/secondary" },
        ] : []
        const WorkspaceContext = createContext()
        const primary = { id: "wsp_primary", generation: 1, scopeID: "scope", type: "directory", path: "/workspace/primary" }
        const [clipboard, setClipboard] = createSignal()
        const [active, setActive] = createSignal(true)
        const [explorerID, setExplorerID] = createSignal(0)
        const h = window.fixture = { calls: [], fail: false, setActive, clipboard, remount: () => setExplorerID(value=>value+1) }
        export { active }
        export { explorerID }

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
        if(new URLSearchParams(location.search).has("many")) tree[""] = Array.from({length:80}, (_,i) => ({path:"root-file-"+i+".txt",name:"root-file-"+i+".txt",type:"file"}))
        h.removeFromDisk = path => {
          const parent = path.split("/").slice(0,-1).join("/")
          tree[parent] = tree[parent].filter(item => item.path !== path)
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
            setStore("nodes", item.path, { ...item, entryVersion: "entry:" + item.path })
          }
        }

        export const FileWorkspaceProvider = (props) => <WorkspaceContext.Provider value={props.workspace}>{props.children}</WorkspaceContext.Provider>
        export const useProjectFiles = () => ({ roots: () => folders, search: async () => [], open: async () => {}, clipboard: { get: clipboard, set: setClipboard } })
        export const useFile = () => {
          const workspace = useContext(WorkspaceContext) ?? primary
          const load = (path) => loadChildren(path, workspace)
          const mutate = async (kind, input, signal) => {
            h.calls.push({kind, ...input, workspaceID: workspace.id, generation: workspace.generation})
            h.lastSignal = signal
            if(h.hold) await new Promise(resolve => { h.release = resolve })
            if(h.fail) throw { data: { message: "Workspace is busy" } }
            const destination = input.to ?? input.path
            const parent = destination.split("/").slice(0,-1).join("/")
            if(kind !== "remove" && tree[parent]?.some(item => item.path === destination))
              throw { data: { message: "Destination already exists" } }
            if(kind === "createFile" || kind === "createDirectory") {
              const parent = input.path.split("/").slice(0,-1).join("/")
              tree[parent] ??= []
              tree[parent].push({path: input.path, name: input.path.split("/").at(-1), type: kind === "createFile" ? "file" : "directory"})
              await load(parent)
            }
            if(kind === "copy") {
              const parent = input.to.split("/").slice(0,-1).join("/")
              tree[parent] ??= []
              tree[parent].push({ ...store.nodes[input.from], path: input.to, name: input.to.split("/").at(-1) })
              await load(parent)
            }
            if(kind === "move") {
              const previous = input.from.split("/").slice(0,-1).join("/")
              const source = tree[previous].find(item => item.path === input.from)
              tree[previous] = tree[previous].filter(item => item.path !== input.from)
              tree[parent] ??= []
              tree[parent].push({ ...source, path: destination, name: destination.split("/").at(-1) })
              await load(previous)
              if(parent !== previous) await load(parent)
            }
            return { path: input.to ?? input.path }
          }
          return {
          workspace,
          resourceKey: workspace.id + "@" + workspace.generation,
          activePath: () => h.activePath,
          get: () => undefined,
          load: async () => {},
          view: { setMode() {} },
          draft: { within: () => false, begin() {} },
          entries: {
            createFile: path => mutate("createFile", {path}),
            createDirectory: path => mutate("createDirectory", {path}),
            move: (input, signal) => mutate("move", input, signal),
            copy: input => mutate("copy", input),
            remove: input => mutate("remove", input),
          },
          openWorkspaceFile: async path => { h.calls.push({kind: "open", path}); return {id: "opened"} },
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
            refresh: async () => { for(const path of Object.keys(store.directories)) await load(path) },
          },
          searchFiles: async () => ({ items: [] }),
        }}
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
        import { configureClipboard } from "@ericsanchezok/synergy-ui/clipboard"
        import { FileExplorer } from ${JSON.stringify(`/@fs/${explorerPath}`)}
        import { ViewActivityProvider } from "@ericsanchezok/synergy-ui/context/view-activity"
        import { active, explorerID } from "./file-stub"
        import { Show } from "solid-js"
        import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
        import ${JSON.stringify(`/@fs/${appSrc}/components/file-workbench/styles.css`)}

        const i18n = setupI18n({ locale: "en", messages: { en: {} } })
        window.fixture.copiedPaths = []
        configureClipboard({ writer: text => { window.fixture.copiedPaths.push(text); return true } })
        render(
          () => <MetaProvider><Font/><ThemeProvider><I18nProvider i18n={i18n}><DialogProvider><ViewActivityProvider active={active}><Show when={explorerID()+1} keyed><FileExplorer onClose={() => {}} /></Show></ViewActivityProvider></DialogProvider></I18nProvider></ThemeProvider></MetaProvider>,
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
        {
          find: "@ericsanchezok/synergy-plugin/theme",
          replacement: path.resolve(import.meta.dir, "../../../../..", "packages/plugin/src/theme/index.ts"),
        },
        { find: "@", replacement: appSrc },
      ],
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "solid-js/jsx-runtime",
        "zod",
        "@lingui/core",
        "@lingui/solid",
      ],
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

  test("entry menus use the product themes and fit a narrow viewport", async () => {
    await page.setViewportSize({ width: 375, height: 600 })
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    const menu = page.getByRole("menu", { name: "File actions", exact: true })
    await menu.waitFor()
    const colors: string[] = []
    await page.locator(".file-entry-popover").evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      await document.fonts.ready
    })
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
      const appearance = await page.locator(".file-entry-popover").evaluate((element) => {
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
    await menu.getByRole("menuitem", { name: "New file", exact: true }).focus()
    await page.keyboard.press("ArrowDown")
    expect(
      await menu
        .getByRole("menuitem", { name: "New folder", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "tree")
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

  test("new entries are named inside the selected folder with validation and no generic action form", async () => {
    await page.setViewportSize({ width: 420, height: 600 })
    await page.goto(baseUrl)
    await page.locator('[data-path="docs"]').click()
    await page.getByRole("button", { name: "New file", exact: true }).click()
    const name = page.getByRole("textbox", { name: "Name", exact: true })
    await name.fill("../outside.md")
    await name.press("Enter")
    await page.getByRole("alert").waitFor()
    expect(await page.getByRole("dialog").count()).toBe(0)
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([])
    await name.fill("api.md")
    await name.press("Enter")
    await page.getByRole("alert").filter({ hasText: "Destination already exists" }).waitFor()
    expect(await name.inputValue()).toBe("api.md")
    await page.evaluate(() => Reflect.get(window, "fixture").removeFromDisk("docs/api.md"))
    await page.getByRole("button", { name: "Refresh files", exact: true }).click()
    await page.locator('[data-path="docs/api.md"]').waitFor({ state: "hidden" })
    await name.fill("api.md")
    await name.press("Enter")
    await page.locator('[data-path="docs/api.md"]').waitFor()
    const calls = await page.evaluate(() => Reflect.get(window, "fixture").calls)
    expect(calls).toContainEqual({
      kind: "createFile",
      path: "docs/api.md",
      workspaceID: "wsp_primary",
      generation: 1,
    })
    expect(calls).toContainEqual({ kind: "open", path: "docs/api.md" })
  }, 30000)

  test("F2 renames in place and retains the observed version and typed name after a write conflict", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').dispatchEvent("mousedown")
    await page.getByRole("tree").press("F2")
    const name = page.getByRole("textbox", { name: "Name", exact: true })
    expect(await name.inputValue()).toBe("api.md")
    await name.fill("renamed.md")
    await page.evaluate(() => {
      Reflect.get(window, "fixture").fail = true
      Reflect.get(window, "fixture").hold = true
    })
    await name.press("Enter")
    await page.waitForFunction(() => Reflect.get(window, "fixture").calls.length === 1)
    expect(await name.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "fixture")
      fixture.hold = false
      fixture.release()
    })
    await page.getByRole("alert").filter({ hasText: "Workspace is busy" }).waitFor()
    expect(await name.inputValue()).toBe("renamed.md")
    expect(await name.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.evaluate(() => {
      Reflect.get(window, "fixture").fail = false
    })
    await name.press("Enter")
    await name.waitFor({ state: "hidden" })
    const calls = await page.evaluate(() => Reflect.get(window, "fixture").calls)
    expect(calls.filter((call: { kind: string }) => call.kind === "move")).toEqual([
      {
        kind: "move",
        from: "docs/api.md",
        to: "docs/renamed.md",
        expectedVersion: "entry:docs/api.md",
        workspaceID: "wsp_primary",
        generation: 1,
      },
      {
        kind: "move",
        from: "docs/api.md",
        to: "docs/renamed.md",
        expectedVersion: "entry:docs/api.md",
        workspaceID: "wsp_primary",
        generation: 1,
      },
    ])
    await page.getByRole("tree").press("F2")
    expect(await name.inputValue()).toBe("renamed.md")
    await name.press("Escape")
    await page.getByRole("tree").press("Delete")
    const confirmation = page.getByRole("dialog", { name: "Delete permanently", exact: true })
    await confirmation.waitFor()
    expect(await confirmation.getByText("docs/renamed.md", { exact: true }).isVisible()).toBe(true)
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
    await confirmation.waitFor({ state: "hidden" })
  }, 30000)

  test("context actions and keyboard cut/paste use captured entries and Escape dismisses only the menu", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    const menu = page.getByRole("menu", { name: "File actions", exact: true })
    await menu.waitFor()
    expect(await page.getByRole("dialog").count()).toBe(0)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    expect(await page.getByRole("tree").isVisible()).toBe(true)
    await page.getByRole("tree").press("Control+x")
    await page.locator('[data-path="docs/nested"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Paste", exact: true }).click()
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toContainEqual({
      kind: "move",
      from: "docs/api.md",
      to: "docs/nested/api.md",
      expectedVersion: "entry:docs/api.md",
      workspaceID: "wsp_primary",
      generation: 1,
    })
    expect(pageErrors).toEqual([])
  }, 30000)

  test("copy and paste in the same folder creates distinct names without overwriting the original", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click()
    for (const path of ["docs/api copy.md", "docs/api copy 2.md"]) {
      await page.locator('[data-path="docs"]').click({ button: "right" })
      await page.getByRole("menuitem", { name: "Paste", exact: true }).click()
      await page.locator(`[data-path="${path}"]`).waitFor()
    }
    const calls = await page.evaluate(() => Reflect.get(window, "fixture").calls)
    expect(calls.filter((call: { kind: string }) => call.kind === "copy")).toEqual([
      {
        kind: "copy",
        from: "docs/api.md",
        to: "docs/api copy.md",
        expectedVersion: "entry:docs/api.md",
        workspaceID: "wsp_primary",
        generation: 1,
      },
      {
        kind: "copy",
        from: "docs/api.md",
        to: "docs/api copy 2.md",
        expectedVersion: "entry:docs/api.md",
        workspaceID: "wsp_primary",
        generation: 1,
      },
    ])
    expect(await page.locator('[data-path="docs/api.md"]').count()).toBe(1)
    expect(pageErrors).toEqual([])
  }, 30000)

  test("empty-area actions use the Workspace root instead of the active document's parent", async () => {
    await page.goto(baseUrl)
    await page.evaluate(() => {
      Reflect.get(window, "fixture").activePath = "docs/api.md"
    })
    const tree = page.getByRole("tree")
    await tree.click({ button: "right", position: { x: 5, y: 300 } })
    await page.getByRole("menuitem", { name: "New folder", exact: true }).click()
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("root-folder")
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
    await page.locator('[data-path="root-folder"]').waitFor()
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click()
    await tree.click({ button: "right", position: { x: 5, y: 300 } })
    await page.getByRole("menuitem", { name: "Paste", exact: true }).click()
    await page.locator('[data-path="api.md"]').waitFor()
    const calls = await page.evaluate(() => Reflect.get(window, "fixture").calls)
    expect(calls).toContainEqual({
      kind: "createDirectory",
      path: "root-folder",
      workspaceID: "wsp_primary",
      generation: 1,
    })
    expect(calls).toContainEqual({
      kind: "copy",
      from: "docs/api.md",
      to: "api.md",
      expectedVersion: "entry:docs/api.md",
      workspaceID: "wsp_primary",
      generation: 1,
    })
  }, 30000)

  test("a focused row action opens its own menu with Enter without opening the document", async () => {
    await page.goto(baseUrl)
    const trigger = page.locator('[data-path="docs/api.md"]').getByRole("button", { name: "File actions", exact: true })
    await trigger.focus()
    await trigger.press("Enter")
    await page.getByRole("menu", { name: "File actions", exact: true }).waitFor()
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([])
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    expect(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue()).toBe("api.md")
  }, 30000)

  test("new-entry input scrolls into the mounted virtual range and Escape cancels without writing", async () => {
    await page.goto(`${baseUrl}?many`)
    await page.getByRole("tree").evaluate((element) => {
      const scroller = element.firstElementChild!
      scroller.scrollTop = scroller.scrollHeight
    })
    await page.locator('[data-path="root-file-79.txt"]').waitFor()
    await page.getByRole("button", { name: "New file", exact: true }).click()
    const input = page.getByRole("textbox", { name: "Name", exact: true })
    await input.waitFor()
    await page.waitForFunction((element) => element === document.activeElement, await input.elementHandle())
    await input.fill("never-created.txt")
    await input.press("Escape")
    await input.waitFor({ state: "hidden" })
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([])
    expect(await page.getByRole("tree").evaluate((element) => element === document.activeElement)).toBe(true)
  }, 30000)

  test("a move keeps its response and destination visibility across a file-panel remount", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Cut", exact: true }).click()
    await page.evaluate(() => {
      Reflect.get(window, "fixture").hold = true
    })
    await page.locator('[data-path="docs/nested"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Paste", exact: true }).click()
    await page.waitForFunction(() => Reflect.get(window, "fixture").lastSignal)
    await page.evaluate(() => Reflect.get(window, "fixture").remount())
    expect(await page.locator('[data-path="docs/nested"]').getAttribute("aria-expanded")).toBe("true")
    expect(await page.evaluate(() => Reflect.get(window, "fixture").lastSignal.aborted)).toBe(false)
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "fixture")
      fixture.hold = false
      fixture.release()
    })
    await page.waitForFunction(() => !Reflect.get(window, "fixture").clipboard())
    expect(pageErrors).toEqual([])
  }, 30000)

  test("copy relative path uses the configured Desktop clipboard writer", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Copy relative path", exact: true }).click()
    expect(await page.evaluate(() => Reflect.get(window, "fixture").copiedPaths)).toEqual(["docs/api.md"])
    expect(pageErrors).toEqual([])
  })

  test("composing Escape preserves an inline name until an ordinary Escape cancels", async () => {
    await page.goto(baseUrl)
    await page.locator('[data-path="docs/api.md"]').click({ button: "right" })
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    const input = page.getByRole("textbox", { name: "Name", exact: true })
    await input.fill("中文草稿.md")
    await input.dispatchEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true })
    expect(await input.isVisible()).toBe(true)
    expect(await input.inputValue()).toBe("中文草稿.md")
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await page.evaluate(() => Reflect.get(window, "fixture").calls)).toEqual([])
    await input.press("Escape")
    await input.waitFor({ state: "hidden" })
    expect(await page.getByRole("tree").evaluate((element) => element === document.activeElement)).toBe(true)
    expect(pageErrors).toEqual([])
  })
})
