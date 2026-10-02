import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser, page: Page, server: ViteDevServer, directory: string, url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../../src")
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".welcome-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<style>body{font-family:system-ui,sans-serif}.fixture-controls{height:36px;white-space:nowrap;overflow:auto;font-size:10px}</style><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { LocaleProvider } from "${source}/context/locale"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { WelcomeProvider, useWelcome, useNewTaskNavigation } from "${source}/components/session/welcome/context"
    import { WelcomeStage } from "${source}/components/session/welcome/stage"
    import { createWelcomeMemory } from "${source}/components/session/welcome/types"
    import { welcomeScenes } from "${source}/components/session/welcome/registry"
    import { handleComposerTypingAutofocus } from "${source}/components/prompt-input/typing-autofocus"
    import "@ericsanchezok/synergy-ui/styles"
    import "${source}/index.css"
    let resolveLate
    const late = {id:"late", title:{id:"fixture.late",message:"Late"}, load:() => new Promise(resolve => {resolveLate=resolve})}
    const fifth = {id:"fifth", title:{id:"fixture.fifth",message:"Fifth"}, load:async() => ({default:() => <button>Fifth scene works</button>})}
    function Assignment(props) {
      const welcome = useWelcome()
      const [route, setRoute] = createSignal("/home/session")
      const newTask = useNewTaskNavigation(path => setRoute(path))
      return <><output data-selection>{JSON.stringify(welcome.experience().selection)}</output><output data-route>{route()}</output><button onClick={()=>newTask("home")}>Explicit new</button><button onClick={()=>setRoute("/project/session")}>Select project</button><button onClick={props.connect}>Connection</button><button onClick={props.reconnect}>Reconnect</button><textarea aria-label="Draft" /></>
    }
    function Lifecycle() {
      const [connection, setConnection] = createSignal("fixture-a")
      return <WelcomeProvider connection={connection()}><Assignment connect={()=>setConnection(c=>c==="fixture-a"?"fixture-b":"fixture-a")} reconnect={()=>setConnection("fixture-a")} /></WelcomeProvider>
    }
    let failCount = 0
    const failing = {id:"failure", title:{id:"fixture.failure",message:"Failure"}, load:async()=>{if(!failCount++) throw Error("Fixture load failure"); return {default:()=> <div>Recovered scene</div>}}}
    function App() {
      if (new URLSearchParams(location.search).has("lifecycle")) return <Lifecycle />
      const theme = useTheme()
      const [definition, setDefinition] = createSignal(welcomeScenes.find(s => s.id === new URLSearchParams(location.search).get("scene")) ?? welcomeScenes[0])
      const [memory, setMemory] = createSignal(createWelcomeMemory())
      const [blocked, setBlocked] = createSignal(false)
      const [shown, setShown] = createSignal(true)
      let input
      document.addEventListener("keydown", e => handleComposerTypingAutofocus(e, input, blocked()))
      const select = value => {setMemory(createWelcomeMemory()); setDefinition(value)}
      return <><div class="fixture-controls"><button onClick={()=>select(failing)}>Load failing</button><button onClick={()=>theme.setThemeId(theme.themeId()==="synergy"?"catppuccin":"synergy")}>Theme</button><button onClick={()=>select(late)}>Load late</button><button onClick={()=>select(fifth)}>Load fifth</button><button onClick={()=>resolveLate?.({default:()=> <div>Obsolete scene</div>})}>Resolve late</button><button onClick={()=>setBlocked(!blocked())}>Overlay</button><button onClick={()=>setShown(!shown())}>Mount</button></div>
        <div class="session-workbench-pane" style="height:calc(100dvh - 36px);display:flex;flex-direction:column">
          <main style="flex:1;min-height:0;overflow:auto"><Show when={shown()}><WelcomeStage definition={definition()} memory={memory()} seed={8} blocked={blocked()} /></Show></main>
          <div class="session-composer"><textarea ref={input} data-component="prompt-input" aria-label="Message" style="height:96px;width:100%" /></div>
        </div></>
    }
    render(() => <LocaleProvider><ThemeProvider><App /></ThemeProvider></LocaleProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind(), ...lingui()],
    resolve: { alias: { "@": source } },
    optimizeDeps: {
      entries: [path.join(directory, "main.tsx")],
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 960, height: 920 } })
  page.setDefaultTimeout(7000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function open(scene = "stack") {
  errors.length = 0
  await page.goto(`${url}?scene=${scene}`)
  await page.locator(".welcome-game-canvas").waitFor()
  expect(errors).toEqual([])
}

test("the background covers the pane, while the game has no pointer focus frame or redundant actions", async () => {
  await open()
  const ambient = await page.locator(".welcome-ambient").boundingBox()
  const pane = await page.locator(".session-workbench-pane").boundingBox()
  expect(ambient!.width).toBeCloseTo(pane!.width)
  expect(ambient!.height).toBeCloseTo(pane!.height)
  const board = page.locator(".welcome-game-canvas")
  await board.click()
  expect(await board.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none")
  expect(await page.getByRole("button", { name: /Pause scene|Make my own version/ }).count()).toBe(0)
  expect(await page.locator(".welcome-topline,.welcome-bottomline").count()).toBe(0)
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
})

test("clicking outside pauses, idle autofocus does not, and a deliberate game action resumes", async () => {
  await open()
  const stage = page.locator(".welcome-stage")
  await page.getByRole("textbox").focus()
  expect(await stage.getAttribute("data-active")).toBe("")
  await page.getByRole("textbox").click()
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.locator(".welcome-game-canvas").click()
  expect(await stage.getAttribute("data-active")).toBe("")
  await page.keyboard.press("Escape")
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.getByRole("textbox").fill("Keep this draft")
  await page.locator(".welcome-game-status").click()
  expect(await stage.getAttribute("data-active")).toBe("")
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep this draft")
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  expect(await stage.getAttribute("data-active")).toBeNull()
})

test("gravity aiming responds to hover before launch, supports cancellation and keyboard delivery", async () => {
  await open("orbit")
  const board = page.locator(".welcome-game-canvas")
  const initial = await board.getAttribute("aria-description")
  const bounds = (await board.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.2)
  expect(await board.getAttribute("aria-description")).not.toBe(initial)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.4)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  expect(await page.locator(".welcome-orbit").getAttribute("data-phase")).toBe("aiming")
  await board.focus()
  await page.keyboard.press("r")
  await page.keyboard.press("Space")
  await page.waitForFunction(() => document.querySelector(".welcome-orbit")?.getAttribute("data-phase") === "delivered")
  expect(errors).toEqual([])
})

test("falling blocks rotate and drop with keyboard, and flight follows the pointer before playing", async () => {
  await open("blocks")
  await page.locator(".welcome-game-canvas").focus()
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("Space")
  expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("4")
  await open("flight")
  const board = page.locator(".welcome-game-canvas")
  const before = await board.getAttribute("aria-description")
  const bounds = (await board.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.7)
  expect(await board.getAttribute("aria-description")).not.toBe(before)
  expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("ready")
  await board.click()
  expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("playing")
  expect(await page.getByRole("textbox").inputValue()).toBe("")
})

test("a fifth module needs no host changes and a late module cannot replace it", async () => {
  await open()
  await page.getByRole("button", { name: "Load late" }).click()
  await page.getByRole("button", { name: "Load fifth" }).click()
  await page.getByRole("button", { name: "Fifth scene works" }).waitFor()
  await page.getByRole("button", { name: "Resolve late" }).click()
  expect(await page.getByText("Obsolete scene").count()).toBe(0)
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  expect(await page.locator(".welcome-ambient").count()).toBe(0)
})

test("narrow and short layouts keep all four games and the editor reachable", async () => {
  for (const scene of ["stack", "orbit", "blocks", "flight"])
    for (const width of [320, 375, 720]) {
      await page.setViewportSize({ width, height: 580 })
      await open(scene)
      await page.locator(".welcome-game-canvas").scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const box = (await page.getByRole("textbox").boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(581)
      expect(errors).toEqual([])
    }
})

test("reduced motion stops decorative frames and supports explicit keyboard play", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open("stack")
  const canvas = page.locator(".welcome-ambient")
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(180)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(before)
  await page.locator(".welcome-game-canvas").focus()
  await page.keyboard.press("Space")
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("each scene supports light, dark, and doubled scale", async () => {
  const captures = process.env.WELCOME_CAPTURE_DIR
  if (captures) await mkdir(captures, { recursive: true })
  for (const scene of ["stack", "orbit", "blocks", "flight"])
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1100, height: 920 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await open(scene)
      if (captures)
        await page
          .locator(".session-workbench-pane")
          .screenshot({ path: path.join(captures, `${scene}-${colorScheme}.png`) })
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
      await page.locator(".welcome-game-canvas").scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
    }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" })
})

test("explicit new, including the same route, owns assignment; project, typing and reconnect do not", async () => {
  await page.goto(`${url}?lifecycle`)
  const read = () =>
    page
      .locator("[data-selection]")
      .textContent()
      .then((value) => JSON.parse(value!))
  const first = await read()
  await page.getByRole("textbox", { name: "Draft" }).fill("Keep my work")
  await page.getByRole("button", { name: "Select project", exact: true }).click()
  await page.getByRole("button", { name: "Reconnect", exact: true }).click()
  expect(await read()).toEqual(first)
  await page.getByRole("button", { name: "Explicit new", exact: true }).click()
  const second = await read()
  expect(second.sceneId).not.toBe(first.sceneId)
  expect(await page.locator("[data-route]").textContent()).toBe("/home/session")
  await page.getByRole("button", { name: "Explicit new", exact: true }).click()
  const third = await read()
  expect(third.sceneId).not.toBe(second.sceneId)
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep my work")
  await page.getByRole("button", { name: "Connection", exact: true }).click()
  const other = await read()
  await page.getByRole("button", { name: "Explicit new", exact: true }).click()
  expect((await read()).sceneId).not.toBe(other.sceneId)
  await page.getByRole("button", { name: "Connection", exact: true }).click()
  expect(await read()).toEqual(third)
  await page.reload()
  expect(await read()).toEqual(third)
})

test("load failure can retry the selected scene while preserving the draft", async () => {
  await open()
  await page.getByRole("textbox").fill("Keep this draft")
  await page.getByRole("button", { name: "Load failing", exact: true }).click()
  await page.getByRole("button", { name: "Retry example" }).click()
  await page.getByText("Recovered scene").waitFor()
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep this draft")
})

test("same-mode theme changes redraw canvas without losing progress, and remount keeps it", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await open("stack")
  const board = page.locator(".welcome-game-canvas")
  await board.focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("Escape")
  const before = await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.waitForTimeout(50)
  expect(await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).not.toBe(before)
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
  expect(errors).toEqual([])
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("ambient motion freezes in place after clicking the title and keyboard focus leaving pauses play", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open("flight")
  const ambient = page.locator(".welcome-ambient")
  const frame = () => ambient.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  const first = await frame()
  await page.waitForTimeout(200)
  expect(await frame()).not.toBe(first)
  const title = (await page.getByRole("heading").boundingBox())!
  await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2)
  await page.waitForTimeout(50)
  const paused = await frame()
  await page.waitForTimeout(120)
  expect(await frame()).toBe(paused)
  const board = page.locator(".welcome-game-canvas")
  await board.click()
  await page.keyboard.press("Tab")
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBeNull()
})

test("touch gestures rotate and drop blocks without changing the draft", async () => {
  await page.setViewportSize({ width: 375, height: 700 })
  await open("blocks")
  const board = page.locator(".welcome-game-canvas")
  const box = (await board.boundingBox())!
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("playing")
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 70 }] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false })
  await touch.detach()
  expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("4")
  expect(await page.getByRole("textbox").inputValue()).toBe("")
  expect(errors).toEqual([])
})
