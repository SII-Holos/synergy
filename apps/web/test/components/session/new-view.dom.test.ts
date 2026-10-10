import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { lingui } from "@lingui/vite-plugin"
import tailwind from "@tailwindcss/vite"

let server: ViteDevServer
let browser: Browser
let page: Page
let base: string
let directory: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".new-view-"))
  await Bun.write(
    path.join(directory, "config.ts"),
    `import { createStore } from "solid-js/store"
    export const [state, patch] = createStore({ welcomeGames: new URLSearchParams(location.search).has("nogames") ? false : undefined })
    window.fixture = { patch, loads: 0, projects: 0, files: 0 }`,
  )
  await Bun.write(
    path.join(directory, "context-sync.ts"),
    `
    import { state } from "./config"
    export const useSync = () => ({ data: { config: { get welcomeGames() { return state.welcomeGames } } } })
    `,
  )
  await Bun.write(
    path.join(directory, "welcome-context.ts"),
    `
    import { createWelcomeMemory } from ${JSON.stringify(`/@fs/${source}/components/session/welcome/types.ts`)}
    const experience = { selection: { sceneId: "stack", seed: 11 }, memory: createWelcomeMemory() }
    export const useWelcome = () => ({ experience: () => experience })
    `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
    import { welcomeScenes } from ${JSON.stringify(`/@fs/${source}/components/session/welcome/registry.ts`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    for (const definition of welcomeScenes) {
      const load = definition.load
      definition.load = () => { window.fixture.loads++; return load() }
    }
    import { LocaleProvider } from ${JSON.stringify(`/@fs/${source}/context/locale/index.ts`)}
    import { NewSessionGreeting } from ${JSON.stringify(`/@fs/${source}/components/session/session-new-view.tsx`)}
    function App() {
      return <div class="session-workbench-pane" style="height:100dvh"><div class="session-empty-view" data-interactive>
        <div class="session-welcome-region">
          <NewSessionGreeting disabled={false} onProject={() => { window.fixture.projects++ }} onFiles={() => { window.fixture.files++ }} />
        </div>
      </div></div>
    }
    render(() => <LocaleProvider><ThemeProvider><DialogProvider><App /></DialogProvider></ThemeProvider></LocaleProvider>, document.getElementById("root"))
    `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind(), ...lingui()],
    resolve: {
      alias: [
        { find: /^@\/context\/sync$/, replacement: `${directory}/context-sync.ts` },
        { find: /^\.\/welcome\/context$/, replacement: `${directory}/welcome-context.ts` },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      watch: null,
      fs: { allow: [path.resolve(source, "../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text())
  })
})

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("welcomeGames disabled renders the plain greeting without the welcome stage", async () => {
  await page.goto(`${base}?nogames`)
  await page.locator(".session-greeting h1").waitFor()
  expect(await page.locator(".session-greeting h1").textContent()).toBe("Bring your ideas to life.")
  expect(await page.locator(".session-greeting p").textContent()).toBe(
    "From a spark to something real. What will you create?",
  )
  expect(await page.locator(".session-greeting-brand, .session-greeting-wordmark").count()).toBe(0)
  expect(await page.locator(".welcome-stage").count()).toBe(0)
  expect(await page.locator(".welcome-ambient").count()).toBe(0)
  expect(await page.locator("canvas").count()).toBe(0)
  expect(await page.locator(".session-greeting .session-starter-actions button").count()).toBe(2)
  expect(await page.evaluate(() => (window as unknown as { fixture: { loads: number } }).fixture.loads)).toBe(0)
  await page.locator(".session-starter-actions button").first().click()
  await page.locator(".session-starter-actions button").last().press("Enter")
  expect(
    await page.evaluate(() => {
      const { projects, files } = (window as unknown as { fixture: { projects: number; files: number } }).fixture
      return { projects, files }
    }),
  ).toEqual({ projects: 1, files: 1 })
  expect(errors).toEqual([])
}, 60_000)

test("unset welcomeGames enables real scenes and live updates dispose and restore them", async () => {
  await page.goto(base)
  await page.locator(".welcome-game-canvas").waitFor()
  expect(await page.locator(".welcome-ambient").count()).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { fixture: { loads: number } }).fixture.loads)).toBe(1)
  expect(await page.locator(".session-greeting").count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as { fixture: { patch: (value: { welcomeGames: boolean }) => void } }).fixture.patch({
      welcomeGames: false,
    }),
  )
  await page.locator(".session-greeting h1").waitFor()
  expect(await page.locator(".welcome-stage, .welcome-ambient, canvas").count()).toBe(0)
  await page.evaluate(() =>
    (window as unknown as { fixture: { patch: (value: { welcomeGames: boolean }) => void } }).fixture.patch({
      welcomeGames: true,
    }),
  )
  await page.locator(".welcome-game-canvas").waitFor()
  expect(await page.locator(".welcome-ambient").count()).toBe(1)
  expect(await page.locator(".session-greeting").count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { fixture: { loads: number } }).fixture.loads)).toBe(2)
  expect(errors).toEqual([])
}, 60_000)

test("plain greeting stays reachable in light and dark narrow and short viewports", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 1440, height: 480 },
    ]) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme })
      await page.goto(`${base}?nogames`)
      const heading = page.locator(".session-greeting h1")
      await heading.waitFor()
      expect(await page.locator("html").getAttribute("data-color-scheme")).toBe(colorScheme)
      const bounds = await heading.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const actions = page.locator(".session-starter-actions button")
      for (const action of await actions.all()) {
        const actionBounds = await action.boundingBox()
        expect(actionBounds).not.toBeNull()
        expect(actionBounds!.height).toBeGreaterThanOrEqual(36)
        expect(actionBounds!.x).toBeGreaterThanOrEqual(0)
        expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(viewport.width)
        expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(viewport.height)
      }
      await page.keyboard.press("Tab")
      expect(await actions.first().evaluate((button) => button === document.activeElement)).toBe(true)
      await page.keyboard.press("Enter")
      await page.keyboard.press("Tab")
      expect(await actions.last().evaluate((button) => button === document.activeElement)).toBe(true)
      await page.keyboard.press("Space")
      expect(
        await page.evaluate(
          () => (window as unknown as { fixture: { projects: number; files: number } }).fixture.projects,
        ),
      ).toBe(1)
      expect(
        await page.evaluate(
          () => (window as unknown as { fixture: { projects: number; files: number } }).fixture.files,
        ),
      ).toBe(1)
      expect(await page.locator(".welcome-stage, .welcome-ambient, canvas").count()).toBe(0)
      expect(errors).toEqual([])
    }
  }
}, 60_000)
