import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { lingui } from "@lingui/vite-plugin"

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
    `export const state = { welcomeGames: !new URLSearchParams(location.search).has("nogames") }`,
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
    import { createSignal } from "solid-js"
    export const useWelcome = () => {
      const [experience] = createSignal({ kind: "stage", seed: 11, memory: {} })
      return { experience }
    }
    `,
  )
  await Bun.write(
    path.join(directory, "welcome-stage.tsx"),
    `export const WelcomeStage = () => <div class="welcome-stage">stage-stub</div>`,
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
    import { LocaleProvider } from ${JSON.stringify(`/@fs/${source}/context/locale/index.ts`)}
    import { NewSessionGreeting } from ${JSON.stringify(`/@fs/${source}/components/session/session-new-view.tsx`)}
    function App() {
      return <div class="session-empty-view" data-interactive>
        <div class="session-welcome-region">
          <NewSessionGreeting interactive disabled={false} onProject={() => {}} onFiles={() => {}} />
        </div>
      </div>
    }
    render(() => <LocaleProvider><DialogProvider><App /></DialogProvider></LocaleProvider>, document.getElementById("root"))
    `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), ...lingui()],
    resolve: {
      alias: [
        { find: /^@\/context\/sync$/, replacement: `${directory}/context-sync.ts` },
        { find: /^\.\/welcome\/context$/, replacement: `${directory}/welcome-context.ts` },
        { find: /^\.\/welcome\/stage$/, replacement: `${directory}/welcome-stage.tsx` },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
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
  expect(await page.locator(".welcome-stage").count()).toBe(0)
  expect(await page.locator(".welcome-ambient").count()).toBe(0)
  expect(await page.locator("canvas").count()).toBe(0)
  expect(await page.locator(".session-greeting .session-starter-actions button").count()).toBe(2)
  expect(errors).toEqual([])
}, 60_000)

test("welcomeGames enabled mounts the interactive welcome stage branch", async () => {
  await page.goto(base)
  await page.locator(".welcome-stage").waitFor()
  expect(await page.locator(".session-greeting").count()).toBe(0)
  expect(errors).toEqual([])
}, 60_000)
