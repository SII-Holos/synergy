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
    const fourth = {id:"fourth", title:{id:"fixture.fourth",message:"Fourth"}, load:async() => ({default:() => <button>Fourth scene works</button>})}
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
      return <><div class="fixture-controls"><button onClick={()=>select(failing)}>Load failing</button><button onClick={()=>theme.setThemeId(theme.themeId()==="synergy"?"catppuccin":"synergy")}>Theme</button><button onClick={()=>select(late)}>Load late</button><button onClick={()=>select(fourth)}>Load fourth</button><button onClick={()=>resolveLate?.({default:()=> <div>Obsolete scene</div>})}>Resolve late</button><button onClick={()=>setBlocked(!blocked())}>Overlay</button><button onClick={()=>setShown(!shown())}>Mount</button></div>
        <div class="session-workbench-pane" style="height:calc(100dvh - 36px);display:flex;flex-direction:column">
          <main style="flex:1;min-height:0;overflow:auto"><div class="session-content-column" style="padding-top:20px;padding-bottom:20px"><Show when={shown()}><WelcomeStage definition={definition()} memory={memory()} seed={8} blocked={blocked()} disabled={false} brand={<b>Synergy</b>} onStart={text=>{input.value=text;input.focus()}} /></Show></div></main>
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
async function open(scene = "island") {
  errors.length = 0
  await page.goto(`${url}?scene=${scene}`)
  await page.locator(".welcome-create").waitFor()
  expect(errors).toEqual([])
}

test("island pieces are playable by keyboard, retain editor ownership, and lead to a draft", async () => {
  await open()
  await page.locator('[data-cell="2,2"]').focus()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Bridge", exact: true }).click()
  await page.locator('[data-cell="3,2"]').focus()
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Road", exact: true }).click()
  await page.locator('[data-cell="4,2"]').focus()
  await page.keyboard.press("Enter")
  await page.getByText("You brought the observatory to life.").waitFor()
  await page.getByRole("button", { name: "Make my own version" }).click()
  expect(await page.getByRole("textbox", { name: "Message" }).inputValue()).toContain("interactive miniature world")
  expect(await page.getByRole("textbox").evaluate((el) => document.activeElement === el)).toBe(true)
})

test("dragging a road previews its destination, commits there, and can be rotated by touch", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open()
  const road = await page.getByRole("button", { name: "Road", exact: true }).boundingBox()
  const cell = page.locator('[data-cell="2,2"]')
  const target = await cell.boundingBox()
  await page.mouse.move(road!.x + road!.width / 2, road!.y + road!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 5 })
  expect(await page.locator("[data-placement-preview]").count()).toBe(1)
  await page.mouse.up()
  expect(await cell.getAttribute("aria-label")).toContain("Road")
  expect(await page.locator("[data-placement-preview]").count()).toBe(0)
  const before = await cell.locator("g[transform]").getAttribute("transform")
  await cell.dispatchEvent("click", { pointerType: "touch" })
  expect(await cell.locator("g[transform]").getAttribute("transform")).not.toBe(before)
})

test("initial editor focus does not freeze the scene; typing, overlays, and pause do", async () => {
  await open()
  const stage = page.locator(".welcome-stage")
  await page.getByRole("textbox").focus()
  expect(await stage.getAttribute("data-active")).toBe("")
  await page.getByRole("textbox").fill("Draft")
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.getByRole("button", { name: "Pause scene" }).click()
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.getByRole("button", { name: "Play scene" }).click()
  expect(await stage.getAttribute("data-active")).toBe("")
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByRole("button", { name: "Play scene" }).waitFor()
  expect(await stage.getAttribute("data-active")).toBeNull()
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("a fourth module needs no host changes and a late module cannot replace it", async () => {
  await open()
  await page.getByRole("button", { name: "Load late" }).click()
  await page.getByRole("button", { name: "Load fourth" }).click()
  await page.getByRole("button", { name: "Fourth scene works" }).waitFor()
  await page.getByRole("button", { name: "Resolve late" }).click()
  expect(await page.getByText("Obsolete scene").count()).toBe(0)
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  expect(await page.locator(".welcome-stage").count()).toBe(0)
})

test("narrow and short layouts keep every scene and the editor reachable", async () => {
  for (const scene of ["island", "nature", "story"]) {
    for (const width of [320, 375, 720]) {
      await page.setViewportSize({ width, height: 580 })
      await open(scene)
      await page.getByRole("button", { name: "Make my own version" }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const box = await page.getByRole("textbox").boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(581)
      expect(errors).toEqual([])
    }
  }
})

test("pausing freezes ambient movement without resetting its position", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open()
  const tree = page.locator(".island-tree").first()
  await page.waitForTimeout(240)
  await page.getByRole("button", { name: "Pause scene" }).click()
  const paused = await tree.evaluate((el) =>
    el.getAnimations().map((a) => ({ state: a.playState, time: a.currentTime })),
  )
  expect(paused).toHaveLength(1)
  expect(paused[0]!.state).toBe("paused")
  await page.waitForTimeout(120)
  expect(await tree.evaluate((el) => el.getAnimations()[0]?.currentTime)).toBe(paused[0]!.time)
})

test("each scene supports light, dark, and doubled scale", async () => {
  const captures = process.env.WELCOME_CAPTURE_DIR
  if (captures) await mkdir(captures, { recursive: true })
  for (const scene of ["island", "nature", "story"]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1000, height: 960 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await open(scene)
      await page.waitForTimeout(150)
      if (captures) await page.screenshot({ path: path.join(captures, `${scene}-${colorScheme}.png`) })
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
      await page.getByRole("button", { name: "Make my own version" }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" })
})

test("nature supports local painting, explicit stepping and safe scene disposal", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open("nature")
  await page.getByRole("button", { name: "Pause scene" }).click()
  const canvas = page.locator(".nature-canvas")
  await canvas.focus()
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Advance one step" }).click()
  await page.waitForTimeout(100)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).not.toBe(before)
  await page.getByRole("button", { name: "Low gravity", exact: true }).click()
  expect(await page.getByRole("button", { name: "Low gravity", exact: true }).getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  expect(await page.getByRole("button", { name: "Low gravity", exact: true }).getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("button", { name: "Load fourth" }).click()
  await page.getByRole("button", { name: "Fourth scene works" }).waitFor()
  expect(await canvas.count()).toBe(0)
  expect(errors).toEqual([])
})

test("story choices change the scene, reach an ending, and can be revisited", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open("story")
  await page.getByRole("button", { name: "Push open the door", exact: true }).first().focus()
  await page.keyboard.press("Enter")
  await page.locator(".story-choices").getByRole("button", { name: "Read the letter" }).click()
  await page.locator(".story-choices").getByRole("button", { name: "Ask about the pendant" }).click()
  await page.locator(".story-choices").getByRole("button", { name: "Give them the letter" }).click()
  expect(await page.locator(".welcome-story").getAttribute("data-node")).toBe("reunion")
  await page.getByRole("button", { name: "Go back a page" }).click()
  expect(await page.locator(".welcome-story").getAttribute("data-node")).toBe("visitor")
  await page.getByRole("button", { name: "Make my own version" }).click()
  expect(await page.getByRole("textbox").inputValue()).toContain("Someone has come home")
  await page.getByRole("button", { name: "Start over", exact: true }).click()
  expect(await page.locator(".welcome-story").getAttribute("data-node")).toBe("arrival")
  expect(errors).toEqual([])
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

test("canvas repaint follows same-mode theme changes without resetting the landscape", async () => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await open("nature")
  const canvas = page.locator(".nature-canvas")
  await page.waitForTimeout(100)
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.waitForTimeout(100)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).not.toBe(before)
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.waitForTimeout(100)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(before)
  await page.emulateMedia({ reducedMotion: "no-preference" })
})
