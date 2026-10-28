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
    '<!doctype html><style>body{font-family:system-ui,sans-serif}.fixture-controls{height:36px;white-space:nowrap;overflow:auto;font-size:10px}</style><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, lazy, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { LocaleProvider } from "${source}/context/locale"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { WelcomeProvider, useWelcome, useNewTaskNavigation } from "${source}/components/session/welcome/context"
    import { WelcomeStage } from "${source}/components/session/welcome/stage"
    import { createWelcomeMemory } from "${source}/components/session/welcome/types"
    import { createStack, dropBlock, advanceStack } from "${source}/components/session/welcome/stack/model"
    import { createSlingshot } from "${source}/components/session/welcome/slingshot/model"
    import { createBlocks } from "${source}/components/session/welcome/blocks/model"
    import { createFlight, startFlight } from "${source}/components/session/welcome/flight/model"
    import { welcomeScenes } from "${source}/components/session/welcome/registry"
    import { sceneRandom } from "${source}/components/session/welcome/random"
    import { sprite, sprites } from "${source}/components/session/welcome/pixels"
    import { handleComposerTypingAutofocus } from "${source}/components/prompt-input/typing-autofocus"
    import "@ericsanchezok/synergy-ui/styles"
    import "${source}/index.css"
    const WelcomeLayout = lazy(() => import("${path.resolve(import.meta.dir, "../../../fixtures/welcome-layout")}").then(module => ({ default: module.WelcomeLayout })))
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
      Object.assign(window, { ambientReference: () => {
        const ambient = document.querySelector(".welcome-ambient")
        const reference = document.createElement("canvas")
        reference.width = ambient.width
        reference.height = ambient.height
        const ctx = reference.getContext("2d")
        const dpr = Math.min(devicePixelRatio || 1, 2)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const random = sceneRandom(8)
         const masks = [...[sprites.star, sprites.ring, sprites.bolt, sprites.sprout, sprites.crate, sprites.drone, sprites.heart].map(mask => mask.map(row => row.replaceAll("2", "0"))), sprites.ribbon]
        for (let index = 0; index < 240; index++) {
          const column = index % 20, row = Math.floor(index / 20)
          const offset = random(), depth = 0.35 + random() * 0.65
          const mask = masks[Math.floor(random() * masks.length)]
          const x = (column + 0.3 + offset * 0.35) * Math.max(62, ambient.clientWidth / 18) + Math.sin(row * 0.6) * 9
          if (x > ambient.clientWidth + 20) continue
          const cycle = ambient.clientHeight + 100
          const y = ((row / 12 * cycle + offset * 40) % cycle) - 45
          const band = 0.6 + 0.4 * Math.sin(column * 0.8 + row * 0.35)
          const edge = Math.min(1, Math.max(0, y / 65), Math.max(0, (ambient.clientHeight - y) / 80))
          ctx.globalAlpha = (0.025 + 0.062 * depth) * band * edge
          sprite(ctx, mask, x, y, depth > 0.65 ? 2 : 1, theme.tokens()["text-strong"])
        }
        return reference.getContext("2d").getImageData(0, 0, reference.width, reference.height).data
      } })
      const [definition, setDefinition] = createSignal(welcomeScenes.find(s => s.id === new URLSearchParams(location.search).get("scene")) ?? welcomeScenes[0])
      const initialMemory = createWelcomeMemory()
      const fixture = new URLSearchParams(location.search).get("fixture")
      if (fixture === "flight-pickups") {
        const flight = createFlight(8)
        initialMemory.write({...flight,pickups:[{id:90,x:280,y:220,kind:"fire"},{id:91,x:360,y:220,kind:"shield"},{id:92,x:440,y:220,kind:"repair"}]})
      }
      if (fixture === "flight-power") {
        const flight = startFlight(createFlight(8))
        initialMemory.write({...flight, spawn:99, pickups:[{id:90,...flight.ship,kind:"fire"},{id:91,...flight.ship,kind:"shield"}]})
      }
      if (fixture === "flight-over") {
        const flight = startFlight(createFlight(8))
        initialMemory.write({...flight, lives:1, spawn:99, enemies:[{id:9,...flight.ship,origin:flight.ship.x,age:0,kind:0,hp:1,flash:0}]})
      }
      if (fixture === "blocks-clear") {
        const blocks = createBlocks(8), board = Array(200).fill(0)
        for(let x=0;x<8;x++) board[190+x]=1
        initialMemory.write({...blocks,board,piece:{kind:1,rotation:0,x:8,y:0}})
      }
      if (fixture === "blocks-over") {
        const blocks = createBlocks(8), board = Array(200).fill(0)
        for(let y=2;y<20;y++) for(let x=3;x<7;x++) board[y*10+x]=1
        initialMemory.write({...blocks,board})
      }
      if (fixture === "stack-miss") {
        const stack = createStack(8)
        initialMemory.write(dropBlock({...stack,moving:{...stack.moving,x:0}}))
      }
      if (fixture === "stack-result") {
        let stack = createStack(8)
        for(let n=0;n<8;n++) {
          stack=dropBlock({...stack,moving:{...stack.moving,x:stack.blocks.at(-1).x}})
          for(let step=0;step<30;step++) stack=advanceStack(stack,1/120)
        }
        initialMemory.write(dropBlock({...stack,moving:{...stack.moving,x:0}}))
      }
      if (fixture === "sling-result") {
        const sling = createSlingshot(8)
        sling.aim(-20,500)
        sling.launch()
        for(let step=0;step<1440 && sling.snapshot().phase === "flying";step++) sling.advance(1/120)
        initialMemory.write(sling.snapshot())
        sling.dispose()
      }
      if (fixture === "sling-last") {
        const sling = createSlingshot(8)
        const snapshot = sling.snapshot()
        sling.dispose()
        initialMemory.write({...snapshot,shots:1,angle:-80,power:160})
      }
      const [memory, setMemory] = createSignal(initialMemory)
      const [blocked, setBlocked] = createSignal(false)
      const [shown, setShown] = createSignal(true)
      let input
      document.addEventListener("keydown", e => handleComposerTypingAutofocus(e, input, blocked()))
      const select = value => {setMemory(createWelcomeMemory()); setDefinition(value)}
      if (new URLSearchParams(location.search).get("layout") === "reserved")
        return <WelcomeLayout definition={definition()} memory={memory()} blocked={blocked()} />
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
    resolve: {
      alias: {
        "@": source,
        "lucide-solid": Bun.resolveSync("lucide-solid", path.resolve(source, "../../../packages/ui")),
      },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "solid-js",
        "solid-js/web",
        "@lingui/core",
        "@lingui/solid",
        "marked",
        "dompurify",
        "lucide-solid",
        "matter-js",
      ],
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

async function openReserved(scene = "slingshot", query = "") {
  errors.length = 0
  await page.goto(`${url}?scene=${scene}&layout=reserved${query}`)
  await page.locator(".welcome-game-canvas").waitFor()
  await page.waitForFunction(
    () =>
      Number.parseFloat(
        getComputedStyle(document.querySelector(".session-workbench-pane")!).getPropertyValue("--prompt-height"),
      ) > 0,
  )
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".welcome-stage")!).opacity === "1")
  expect(errors).toEqual([])
}

async function settledDock() {
  await page.waitForFunction(() => {
    const dock = document.querySelector(".session-prompt-dock")!
    const pane = document.querySelector(".session-workbench-pane")!
    return (
      Number.parseFloat(getComputedStyle(pane).getPropertyValue("--prompt-height")) ===
      Math.ceil(dock.getBoundingClientRect().height)
    )
  })
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

const fieldGeometry = () =>
  page.locator(".welcome-game-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const { x, y, width, height } = canvas.getBoundingClientRect()
    return { x, y, width, height, bitmapWidth: canvas.width, bitmapHeight: canvas.height }
  })

for (const width of [960, 375]) {
  test(`content and dock growth leave the welcome background geometry unchanged at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 920 })
    await openReserved("blocks")
    await settledDock()
    const field = await fieldGeometry()
    const dock = page.locator(".session-prompt-dock")
    const initialHeight = (await dock.boundingBox())!.height
    const editor = page.getByRole("textbox", { name: "Message" })
    await editor.fill(Array(20).fill("A naturally growing draft line").join("\n"))
    await settledDock()
    expect((await dock.boundingBox())!.height).toBeGreaterThan(initialHeight + 100)
    expect(await page.locator(".session-composer").getAttribute("data-resized")).toBeNull()
    expect(await fieldGeometry()).toEqual(field)
    expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")

    for (const selector of ["[data-attach]", "[data-pending-toggle]"]) {
      const before = (await dock.boundingBox())!.height
      await page.locator(selector).click()
      await settledDock()
      expect((await dock.boundingBox())!.height).toBeGreaterThan(before)
      expect(await fieldGeometry()).toEqual(field)
    }
    await editor.fill("")
    await page.locator("[data-attach]").click()
    await page.locator("[data-pending-toggle]").click()
    await settledDock()
    expect((await dock.boundingBox())!.height).toBe(initialHeight)
    expect(await fieldGeometry()).toEqual(field)
    expect(errors).toEqual([])
  })

  test(`a cold tall draft uses the same welcome geometry as an empty draft at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 920 })
    await openReserved("blocks")
    await settledDock()
    const empty = await fieldGeometry()
    await openReserved("blocks", "&draft&attachments")
    await settledDock()
    expect(await page.getByRole("textbox", { name: "Message" }).innerText()).toContain("Restored draft line")
    expect(await fieldGeometry()).toEqual(empty)
    expect(errors).toEqual([])
  })
}

test("the background follows viewport geometry during expanded editing without retaining an old height", async () => {
  await page.setViewportSize({ width: 960, height: 1020 })
  await openReserved("blocks")
  await settledDock()
  const initial = await fieldGeometry()
  await page.locator("[data-expand]").click()
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
  expect(await fieldGeometry()).toEqual(initial)
  await page.setViewportSize({ width: 960, height: 760 })
  await settledDock()
  const resized = await fieldGeometry()
  expect(resized.height).toBeLessThan(initial.height)
  await page.locator("[data-expand]").click()
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
  await settledDock()
  expect(await fieldGeometry()).toEqual(resized)
  await openReserved("blocks")
  await settledDock()
  expect(await fieldGeometry()).toEqual(resized)
  expect(errors).toEqual([])
})

test("a short narrow welcome scrolls the playfield above the compact composer and preserves transcript flow", async () => {
  await page.setViewportSize({ width: 375, height: 540 })
  await openReserved("blocks")
  await settledDock()
  const scroller = page.locator(".session-empty-view")
  const bounds = (await scroller.boundingBox())!
  await page.mouse.move(bounds.x + 24, bounds.y + 80)
  await page.mouse.wheel(0, 1000)
  await page.waitForFunction(() => document.querySelector(".session-empty-view")!.scrollTop > 0)
  const canvas = (await page.locator(".welcome-game-canvas").boundingBox())!
  const dock = (await page.locator(".session-prompt-dock").boundingBox())!
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(dock.y)
  const send = page.getByRole("button", { name: "Send", exact: true })
  expect(
    await send.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }),
  ).toBe(true)
  await page.locator("[data-conversation-toggle]").click()
  await settledDock()
  const conversation = (await page.locator("[data-conversation-presentation]").boundingBox())!
  const transcriptDock = (await page.locator(".session-prompt-dock").boundingBox())!
  expect(conversation.y + conversation.height).toBeCloseTo(transcriptDock.y, 0)
  expect(errors).toEqual([])
})

test("a tall dock leaves the complete playfield and empty-view contributions reachable in a short window", async () => {
  await page.setViewportSize({ width: 375, height: 540 })
  await openReserved("blocks", "&draft&attachments")
  await settledDock()
  const scroller = page.locator(".session-empty-view")
  const scrollToEnd = async () => {
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  }
  await scrollToEnd()
  const canvas = (await page.locator(".welcome-game-canvas").boundingBox())!
  const dock = (await page.locator(".session-prompt-dock").boundingBox())!
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(dock.y)
  await page.locator("[data-extension-toggle]").click()
  await scrollToEnd()
  const action = page.getByRole("button", { name: "Extension action", exact: true })
  const button = (await action.boundingBox())!
  expect(button.y + button.height).toBeLessThanOrEqual(dock.y)
  expect(
    await action.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("plain greetings and the native dock stay independent across the mobile breakpoint", async () => {
  await page.setViewportSize({ width: 767, height: 920 })
  await openReserved("blocks")
  await settledDock()
  await page.locator("[data-games-toggle]").click()
  const heading = (await page.locator(".welcome-scene-heading").boundingBox())!
  expect(await page.locator(".welcome-stage,.welcome-ambient").count()).toBe(0)
  await page.getByRole("textbox", { name: "Message" }).fill(Array(20).fill("Draft line").join("\n"))
  await settledDock()
  expect(await page.locator(".welcome-scene-heading").boundingBox()).toEqual(heading)
  for (const width of [767, 768, 375]) {
    await page.setViewportSize({ width, height: 920 })
    await settledDock()
    expect(await page.locator(".session-prompt-dock").evaluate((element) => getComputedStyle(element).position)).toBe(
      "absolute",
    )
  }
  await page.locator("[data-games-toggle]").click()
  await page.locator(".welcome-game-canvas").waitFor()
  expect(errors).toEqual([])
})

test("expanding the composer covers the playfield without resizing, repainting or moving it", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await openReserved("slingshot")
  await settledDock()
  const canvas = page.locator(".welcome-game-canvas")
  const stage = page.locator(".welcome-stage")
  const restingDock = (await page.locator(".session-prompt-dock").boundingBox())!
  const restingBox = (await canvas.boundingBox())!
  const bitmap = () => canvas.evaluate((el) => [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height])
  const restingBitmap = await bitmap()

  await page.locator("[data-expand]").click()
  await page.waitForFunction(() => {
    const composer = document.querySelector(".session-composer")
    return composer?.hasAttribute("data-expanded") && !composer.hasAttribute("data-motion")
  })
  await settledDock()
  expect((await page.locator(".session-prompt-dock").boundingBox())!.height).toBeGreaterThan(restingDock.height + 100)
  expect(await stage.getAttribute("data-active")).toBeNull()

  const expandedBox = (await canvas.boundingBox())!
  expect(Math.abs(expandedBox.width - restingBox.width)).toBeLessThan(0.5)
  expect(Math.abs(expandedBox.height - restingBox.height)).toBeLessThan(0.5)
  expect(Math.abs(expandedBox.x - restingBox.x)).toBeLessThan(0.5)
  expect(Math.abs(expandedBox.y - restingBox.y)).toBeLessThan(0.5)
  expect(await bitmap()).toEqual(restingBitmap)
  expect(await stage.getAttribute("data-covered")).toBe("")

  await page.locator("[data-expand]").click()
  await page.waitForFunction(() => {
    const composer = document.querySelector(".session-composer")
    return composer && !composer.hasAttribute("data-expanded") && !composer.hasAttribute("data-motion")
  })
  await settledDock()
  expect((await page.locator(".session-prompt-dock").boundingBox())!.height).toBeCloseTo(restingDock.height, 0)
  const restored = (await canvas.boundingBox())!
  expect(Math.abs(restored.height - restingBox.height)).toBeLessThan(0.5)
  expect(await stage.getAttribute("data-active")).toBe("")
  expect(errors).toEqual([])
})

test("dragging the composer taller covers the playfield without resizing it", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await openReserved("slingshot")
  const canvas = page.locator(".welcome-game-canvas")
  const stage = page.locator(".welcome-stage")
  const restingBox = (await canvas.boundingBox())!
  const bitmap = () => canvas.evaluate((el) => [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height])
  const restingBitmap = await bitmap()

  await page.locator("[data-resize]").click()
  await page.waitForTimeout(400)
  expect(await stage.getAttribute("data-covered")).toBe("")

  const resizedBox = (await canvas.boundingBox())!
  expect(Math.abs(resizedBox.width - restingBox.width)).toBeLessThan(0.5)
  expect(Math.abs(resizedBox.height - restingBox.height)).toBeLessThan(0.5)
  expect(Math.abs(resizedBox.y - restingBox.y)).toBeLessThan(0.5)
  expect(await bitmap()).toEqual(restingBitmap)

  await page.locator("[data-resize]").click()
  await page.waitForTimeout(400)
  expect(await stage.getAttribute("data-covered")).toBeNull()
  const restored = (await canvas.boundingBox())!
  expect(Math.abs(restored.height - restingBox.height)).toBeLessThan(0.5)
  expect(errors).toEqual([])
})

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
  await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-height") === "1")
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
})

test("composer input and focus changes keep play running while Escape explicitly pauses", async () => {
  await open()
  const stage = page.locator(".welcome-stage")
  const board = page.locator(".welcome-game-canvas")
  await page.getByRole("textbox").focus()
  expect(await stage.getAttribute("data-active")).toBe("")
  await page.getByRole("textbox").click()
  await page.getByRole("textbox").fill("Keep this draft")
  await page.getByRole("textbox").dispatchEvent("compositionstart", { bubbles: true })
  await page.getByRole("textbox").dispatchEvent("compositionend", { bubbles: true })
  expect(await stage.getAttribute("data-active")).toBe("")
  const moving = await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.waitForFunction(
    (snapshot) => document.querySelector<HTMLCanvasElement>(".welcome-game-canvas")?.toDataURL() !== snapshot,
    moving,
  )
  await page.keyboard.press("Shift+Tab")
  expect(await board.evaluate((el) => document.activeElement === el)).toBe(true)
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("0")
  await page.keyboard.press("Escape")
  expect(await stage.getAttribute("data-active")).toBeNull()
  const paused = await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.getByRole("textbox").click()
  await page.waitForTimeout(120)
  expect(await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(paused)
  await board.focus()
  expect(await stage.getAttribute("data-active")).toBeNull()
  await board.press("Space")
  expect(await stage.getAttribute("data-active")).toBe("")
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep this draft")
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  expect(await stage.getAttribute("data-active")).toBeNull()
})

test("keyboard focus marks the game status without tinting the entire playfield", async () => {
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await open("slingshot")
      await page.getByRole("textbox").click()
      await page.getByRole("textbox").fill("Typing before returning to the game")
      await page.keyboard.press("Shift+Tab")
      const canvas = page.locator(".welcome-game-canvas")
      expect(await canvas.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
      expect(
        await page.locator(".welcome-game-status").evaluate((el) => getComputedStyle(el).textDecorationLine),
      ).toContain("underline")
      expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none")
      expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      if (process.env.WELCOME_CAPTURE_DIR) {
        await mkdir(process.env.WELCOME_CAPTURE_DIR, { recursive: true })
        await page.locator(".session-workbench-pane").screenshot({
          path: path.join(process.env.WELCOME_CAPTURE_DIR, `keyboard-focus-${colorScheme}.png`),
        })
      }
      await canvas.click()
      expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none")
      await page.emulateMedia({ forcedColors: "active" })
      await page.getByRole("textbox").focus()
      const resting = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(resting).toMatch(/^rgba\([^)]*, 0\)$/)
      await page.keyboard.press("Shift+Tab")
      expect(await canvas.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
      expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none")
      expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(resting)
      await page.emulateMedia({ forcedColors: "none" })
    }
  } finally {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference", forcedColors: "none" })
  }
})

test("focus loss releases held controls while gravity and flight continue", async () => {
  for (const scene of ["blocks", "flight"])
    for (const destination of ["composer", "window"]) {
      await open(scene)
      const canvas = page.locator(".welcome-game-canvas")
      const position = () =>
        scene === "blocks"
          ? page.locator(".welcome-blocks").getAttribute("data-column")
          : canvas.getAttribute("aria-description")
      await canvas.focus()
      await page.keyboard.down("ArrowRight")
      await page.waitForTimeout(50)
      if (destination === "composer") await page.getByRole("textbox").focus()
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")))
      const released = await position()
      await page.waitForTimeout(230)
      const settled = await position()
      await page.keyboard.up("ArrowRight")
      expect(settled).toBe(released)
      expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
      await page.getByRole("textbox").fill("Draft")
      await page.getByRole("textbox").press("End")
      await page.keyboard.type(" r ")
      await page.keyboard.press("ArrowUp")
      expect(await page.getByRole("textbox").inputValue()).toBe("Draft r ")
      expect(await position()).toBe(released)
      if (scene === "blocks") {
        expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("0")
        await page.waitForFunction(
          () => Number(document.querySelector(".welcome-blocks")?.getAttribute("data-row")) > 0,
        )
      } else {
        const frame = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
        await page.waitForFunction(
          (snapshot) => document.querySelector<HTMLCanvasElement>(".welcome-game-canvas")?.toDataURL() !== snapshot,
          frame,
        )
      }
    }
})

test("focus loss cancels captured slingshot pulls without firing or pausing", async () => {
  for (const destination of ["composer", "window"]) {
    await open("slingshot")
    const canvas = page.locator(".welcome-game-canvas")
    const box = (await canvas.boundingBox())!
    const scale = Math.min(box.width / 720, box.height / 360)
    const x = box.x + (box.width - 720 * scale) / 2 + 98 * scale
    const y = box.y + box.height - 360 * scale + 224 * scale
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 45 * scale, y + 40 * scale)
    if (destination === "composer") await page.getByRole("textbox").focus()
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await page.mouse.up()
    expect(await page.locator(".welcome-slingshot").getAttribute("data-phase")).toBe("aiming")
    expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("3")
    expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
  }
})

test("slingshot aims before launch, cancels pulls, and completes a level with keyboard shots", async () => {
  await open("slingshot")
  const board = page.locator(".welcome-game-canvas")
  const initial = await board.getAttribute("aria-description")
  const bounds = (await board.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.2)
  expect(await board.getAttribute("aria-description")).not.toBe(initial)
  const scale = Math.min(bounds.width / 720, bounds.height / 360)
  const x = bounds.x + (bounds.width - 720 * scale) / 2 + 98 * scale
  const y = bounds.y + bounds.height - 360 * scale + 224 * scale
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 45 * scale, y + 40 * scale)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  expect(await page.locator(".welcome-slingshot").getAttribute("data-phase")).toBe("aiming")
  expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("3")
  await board.focus()
  await page.keyboard.press("r")
  for (let n = 0; n < 15; n++) await page.keyboard.press("ArrowLeft")
  for (let n = 0; n < 2; n++) await page.keyboard.press("ArrowUp")
  await page.keyboard.press("Space")
  await page.getByRole("textbox").fill("Let the launched shot finish")
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
  await page.waitForFunction(
    () => document.querySelector(".welcome-slingshot")?.getAttribute("data-phase") === "won",
    undefined,
    { timeout: 12000 },
  )
  await board.click()
  expect(await page.locator(".welcome-slingshot").getAttribute("data-level")).toBe("1")
  expect(await page.getByRole("textbox").inputValue()).toBe("Let the launched shot finish")
  expect(errors).toEqual([])
}, 20000)

test("falling blocks rotate and drop with keyboard, and flight follows the pointer before playing", async () => {
  await open("blocks")
  const blockBoard = page.locator(".welcome-game-canvas")
  const column = await page.locator(".welcome-blocks").getAttribute("data-column")
  const blockBounds = (await blockBoard.boundingBox())!
  await page.mouse.move(blockBounds.x + blockBounds.width * 0.8, blockBounds.y + blockBounds.height * 0.5)
  expect(await page.locator(".welcome-blocks").getAttribute("data-column")).not.toBe(column)
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("ready")
  await blockBoard.focus()
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
  for (const scene of ["stack", "slingshot", "blocks", "flight"])
    for (const width of [320, 375, 720])
      for (const height of [400, 580]) {
        await page.setViewportSize({ width, height })
        await open(scene)
        await page.locator(".welcome-game-canvas").scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const box = (await page.getByRole("textbox").boundingBox())!
        expect(box.y + box.height).toBeLessThanOrEqual(height + 1)
        expect(errors).toEqual([])
      }
}, 15000)

test("reduced motion stops decorative frames and supports explicit keyboard play", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open("stack")
  const canvas = page.locator(".welcome-ambient")
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(180)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(before)
  await page.locator(".welcome-game-canvas").focus()
  await page.keyboard.press("Space")
  await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-height") === "1")
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("each scene supports light, dark, and doubled scale", async () => {
  const captures = process.env.WELCOME_CAPTURE_DIR
  if (captures) await mkdir(captures, { recursive: true })
  for (const scene of ["stack", "slingshot", "blocks", "flight"])
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1100, height: 920 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await open(scene === "flight" ? "flight&fixture=flight-pickups" : scene)
      if (captures) {
        for (const width of [960, 375]) {
          await page.setViewportSize({ width, height: 920 })
          await page.waitForFunction(() => getComputedStyle(document.querySelector(".welcome-stage")!).opacity === "1")
          await page
            .locator(".session-workbench-pane")
            .screenshot({ path: path.join(captures, `${scene}-${colorScheme}-${width}.png`) })
          const pixels = await page
            .locator(".welcome-ambient")
            .evaluate((el) => (el as HTMLCanvasElement).toDataURL().split(",")[1]!)
          await Bun.write(
            path.join(captures, `ambient-${scene}-${colorScheme}-${width}.png`),
            Buffer.from(pixels, "base64"),
          )
        }
        await page.setViewportSize({ width: 1100, height: 920 })
      }
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
  await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-height") === "1")
  await page.keyboard.press("Escape")
  const before = await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.waitForTimeout(50)
  expect(await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).not.toBe(before)
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-height") === "1")
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("1")
  expect(errors).toEqual([])
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("ambient frames reuse pixel motifs instead of repainting their cells", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await open("flight")
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.evaluate(() => {
    const fills = new Map<HTMLCanvasElement, number>()
    const buffers = new Set<HTMLCanvasElement>()
    let images = 0
    const originalFill = CanvasRenderingContext2D.prototype.fillRect
    const originalImage = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.fillRect = function (this: CanvasRenderingContext2D, ...args) {
      fills.set(this.canvas, (fills.get(this.canvas) ?? 0) + 1)
      return originalFill.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args) {
      if (this.canvas.classList.contains("welcome-ambient")) {
        images++
        if (args[0] instanceof HTMLCanvasElement) buffers.add(args[0])
      }
      return Reflect.apply(originalImage, this, args)
    } as typeof originalImage
    Object.assign(window, {
      ambientDrawCounts: () => ({
        cells: Array.from(fills).reduce(
          (total, [canvas, count]) =>
            total + (buffers.has(canvas) || canvas.classList.contains("welcome-ambient") ? count : 0),
          0,
        ),
        images,
        buffers: Array.from(buffers, (canvas) => ({ width: canvas.width, height: canvas.height })),
      }),
      restoreAmbientDrawing: () => {
        CanvasRenderingContext2D.prototype.fillRect = originalFill
        CanvasRenderingContext2D.prototype.drawImage = originalImage
      },
    })
  })
  const readCounts = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          ambientDrawCounts: () => { cells: number; images: number; buffers: { width: number; height: number }[] }
        }
      ).ambientDrawCounts(),
    )
  try {
    await page.getByRole("button", { name: "Mount", exact: true }).click()
    await page.locator(".welcome-game-canvas").waitFor()
    await page.getByRole("textbox").click()
    const initial = await readCounts()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.waitForFunction((previous) => {
      const counts = (
        window as unknown as { ambientDrawCounts: () => { cells: number; images: number } }
      ).ambientDrawCounts()
      return counts.cells + counts.images > previous + 480
    }, initial.cells + initial.images)
    const moving = await readCounts()
    expect(moving.cells - initial.cells).toBe(0)
    expect(moving.images).toBeGreaterThan(initial.images)
    expect(moving.buffers).toHaveLength(9)
    await page.emulateMedia({ reducedMotion: "reduce" })
    const ambient = page.locator(".welcome-ambient")
    const frame = () => ambient.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
    const beforeTheme = await frame()
    const cached = await readCounts()
    await page.getByRole("button", { name: "Theme", exact: true }).click()
    await page.waitForFunction(
      (snapshot) => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.toDataURL() !== snapshot,
      beforeTheme,
    )
    const themed = await readCounts()
    expect(themed.cells - cached.cells).toBe(initial.cells)
    expect(themed.buffers).toEqual(initial.buffers)
    await page.setViewportSize({ width: 375, height: 700 })
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>(".welcome-ambient")!.clientWidth < 400)
    await page.waitForFunction(
      (previous) =>
        (window as unknown as { ambientDrawCounts: () => { images: number } }).ambientDrawCounts().images > previous,
      themed.images,
    )
    expect((await readCounts()).cells).toBe(themed.cells)
    await page.getByRole("button", { name: "Mount", exact: true }).click()
    expect((await readCounts()).buffers).toEqual(Array.from({ length: 9 }, () => ({ width: 0, height: 0 })))
    expect(await page.locator(".welcome-ambient").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await page.evaluate(() => (window as unknown as { restoreAmbientDrawing: () => void }).restoreAmbientDrawing())
    await page.emulateMedia({ reducedMotion: "no-preference" })
  }
})

test("nearby ribbons reveal theme color without moving reduced-motion scenery or intercepting input", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await page.mouse.move(0, 0)
  await open("stack")
  const ambient = page.locator(".welcome-ambient")
  const inspect = () =>
    ambient.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
      const occupied: number[] = []
      let colored = 0
      for (let offset = 0; offset < data.length; offset += 4) {
        if (!data[offset + 3]) continue
        occupied.push(offset / 4)
        if (
          data[offset + 3]! > 30 &&
          Math.max(...data.slice(offset, offset + 3)) - Math.min(...data.slice(offset, offset + 3)) > 25
        )
          colored++
      }
      return { occupied, colored, image: canvas.toDataURL() }
    })
  const initial = await inspect()
  expect(initial.colored).toBe(0)
  const pane = (await page.locator(".session-workbench-pane").boundingBox())!
  let revealed = initial
  for (const x of [0.25, 0.5, 0.75]) {
    await page.mouse.move(pane.x + pane.width * x, pane.y + pane.height * 0.4)
    revealed = await inspect()
    if (revealed.colored > 0) break
  }
  expect(revealed.colored).toBeGreaterThan(0)
  expect(revealed.occupied).toEqual(initial.occupied)
  expect(await ambient.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none")
  await page.waitForTimeout(160)
  expect((await inspect()).image).toBe(revealed.image)
  await page.getByRole("textbox").fill("The background does not capture typing")
  expect(await page.getByRole("textbox").inputValue()).toBe("The background does not capture typing")
  await page.getByRole("button", { name: "Theme", exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await page.waitForFunction(
    (image) => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.toDataURL() !== image,
    revealed.image,
  )
  const themed = await inspect()
  expect(themed.colored).toBeGreaterThan(0)
  expect(themed.occupied).toEqual(initial.occupied)
  await page.getByRole("button", { name: "Theme", exact: true }).evaluate((el) => (el as HTMLButtonElement).click())
  await page.waitForFunction(
    (image) => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.toDataURL() === image,
    revealed.image,
  )
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect((await inspect()).colored).toBe(0)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect((await inspect()).colored).toBe(0)
  await page.locator(".session-workbench-pane").dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: pane.x + pane.width / 4,
    clientY: pane.y + pane.height * 0.4,
  })
  expect((await inspect()).colored).toBe(0)
  await page.mouse.move(0, 0)
  expect((await inspect()).image).toBe(initial.image)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  expect(errors).toEqual([])
})

test("ambient caching preserves cell coverage at real integer and fractional device scales", async () => {
  for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({ deviceScaleFactor, reducedMotion: "reduce" })
    const scaled = await context.newPage()
    try {
      for (const width of [960, 375])
        for (const colorScheme of ["light", "dark"] as const) {
          await scaled.setViewportSize({ width, height: 920 })
          await scaled.emulateMedia({ colorScheme })
          await scaled.goto(`${url}?scene=flight`)
          await scaled.locator(".welcome-game-canvas").waitFor()
          await scaled.waitForFunction(() => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.width)
          const result = await scaled.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(".welcome-ambient")!
            const actual = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
            const expected = (window as unknown as { ambientReference: () => Uint8ClampedArray }).ambientReference()
            let occupiedMismatch = 0,
              maxAlpha = 0,
              maxComposite = 0
            for (let index = 0; index < actual.length; index += 4) {
              const a = actual[index + 3]!,
                b = expected[index + 3]!
              if (a > 0 !== b > 0) occupiedMismatch++
              maxAlpha = Math.max(maxAlpha, Math.abs(a - b))
              for (let color = 0; color < 3; color++)
                for (const background of [0, 255]) {
                  const ac = Math.round((actual[index + color]! * a + background * (255 - a)) / 255)
                  const bc = Math.round((expected[index + color]! * b + background * (255 - b)) / 255)
                  maxComposite = Math.max(maxComposite, Math.abs(ac - bc))
                }
            }
            return { dpr: devicePixelRatio, occupiedMismatch, maxAlpha, maxComposite }
          })
          expect(result.dpr).toBe(deviceScaleFactor)
          expect(result.occupiedMismatch).toBe(0)
          expect(result.maxAlpha).toBe(0)
          expect(result.maxComposite).toBeLessThanOrEqual(1)
        }
    } finally {
      await context.close()
    }
  }
}, 60000)

test("outside clicks and keyboard focus leave both game and ambient motion running", async () => {
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
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
  const paused = await frame()
  await page.waitForTimeout(120)
  expect((await frame()) === paused).toBe(false)
  const board = page.locator(".welcome-game-canvas")
  await board.click()
  await page.keyboard.press("Tab")
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
  expect(await ambient.getAttribute("data-moving")).toBe("")
})

test("explicit pause and obscured games freeze independently of the ambient field", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open("flight")
  const stage = page.locator(".welcome-stage")
  const board = page.locator(".welcome-game-canvas")
  const ambient = page.locator(".welcome-ambient")
  const frame = () => ambient.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  const remainsMoving = async () => {
    await page.waitForFunction(() => !document.querySelector(".welcome-stage")?.hasAttribute("data-active"))
    expect(await stage.getAttribute("data-active")).toBeNull()
    expect(await ambient.getAttribute("data-moving")).toBe("")
    const before = await frame()
    await page.waitForFunction(
      (snapshot) => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.toDataURL() !== snapshot,
      before,
    )
    const game = await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
    await page.waitForTimeout(120)
    expect((await board.evaluate((el) => (el as HTMLCanvasElement).toDataURL())) === game).toBe(true)
  }
  await board.click()
  expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("playing")
  await page.locator(".welcome-game-status").click()
  await remainsMoving()
  await page.locator(".welcome-game-status").click()
  await page.keyboard.press("Escape")
  await remainsMoving()
  await page.getByRole("textbox").fill("Keep this draft")
  await remainsMoving()
  await page.locator(".welcome-game-status").click()
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  await remainsMoving()
  await page.getByRole("button", { name: "Overlay", exact: true }).click()
  await page.locator(".session-composer").evaluate((el) => el.setAttribute("data-expanded", ""))
  await remainsMoving()
  await page.locator(".session-composer").evaluate((el) => el.removeAttribute("data-expanded"))
  await page.locator("main").evaluate((el) => (el.style.display = "none"))
  await remainsMoving()
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep this draft")
  expect(errors).toEqual([])
}, 15000)

test("ambient visibility and reduced motion resume without resuming a paused game", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open("blocks")
  await page.locator(".welcome-game-canvas").focus()
  await page.keyboard.press("Escape")
  const stage = page.locator(".welcome-stage")
  const ambient = page.locator(".welcome-ambient")
  const frame = () => ambient.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  const expectFrozen = async () => {
    await page.waitForFunction(() => !document.querySelector(".welcome-ambient")?.hasAttribute("data-moving"))
    expect(await ambient.getAttribute("data-moving")).toBeNull()
    const before = await frame()
    await page.waitForTimeout(160)
    expect((await frame()) === before).toBe(true)
  }
  const expectMoving = async () => {
    await page.waitForFunction(() => document.querySelector(".welcome-ambient")?.hasAttribute("data-moving"))
    expect(await stage.getAttribute("data-active")).toBeNull()
    expect(await ambient.getAttribute("data-moving")).toBe("")
    const before = await frame()
    await page.waitForFunction(
      (snapshot) => document.querySelector<HTMLCanvasElement>(".welcome-ambient")?.toDataURL() !== snapshot,
      before,
    )
  }
  await expectMoving()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expectFrozen()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expectMoving()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expectFrozen()
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expectMoving()
  expect(errors).toEqual([])
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

test("Escape cancels a captured falling-block gesture without starting the round", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open("blocks")
  const box = (await page.locator(".welcome-game-canvas").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.keyboard.press("Escape")
  await page.mouse.up()
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("ready")
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBeNull()
})

test("settled tower floors remain opaque across their contact at normal and doubled scale", async () => {
  for (const zoom of [1, 2]) {
    await page.setViewportSize({ width: 960, height: 920 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await open("stack")
    await page.evaluate((value) => (document.documentElement.style.zoom = String(value)), zoom)
    const board = page.locator(".welcome-game-canvas")
    await board.press("Space")
    await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-height") === "1")
    const solid = await board.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      const scale = Math.min(canvas.width / 720, canvas.height / 340)
      const x = Math.round((canvas.width - 720 * scale) / 2 + 360 * scale)
      const top = Math.ceil(canvas.height - 340 * scale + 284 * scale)
      const bottom = Math.floor(canvas.height - 340 * scale + 305 * scale)
      const data = canvas.getContext("2d")!.getImageData(x, top, 1, bottom - top).data
      return Array.from(data)
        .filter((_, i) => i % 4 === 3)
        .every((alpha) => alpha === 255)
    })
    expect(solid).toBe(true)
  }
})

test("flight pickups show timed effects, freeze on explicit pause, and a loss restarts locally", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open("flight&fixture=flight-power")
  await page.waitForFunction(() => document.querySelector(".welcome-flight")?.getAttribute("data-fire") === "true")
  expect(await page.locator(".welcome-flight").getAttribute("data-shield")).toBe("true")
  expect(await page.locator(".welcome-game-status").textContent()).toContain("Firepower")
  expect(await page.locator(".welcome-game-status").textContent()).toContain("Shield")
  expect(await page.getByRole("status").textContent()).toContain("One-hit protection")
  await page.locator(".welcome-game-canvas").press("Escape")
  await page.getByRole("textbox").click()
  const canvas = page.locator(".welcome-game-canvas")
  const paused = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(200)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(paused)
  await open("flight&fixture=flight-over")
  await page.waitForFunction(() => document.querySelector(".welcome-flight")?.getAttribute("data-phase") === "over")
  await page.locator(".welcome-game-canvas").click()
  expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("playing")
  expect(await page.locator(".welcome-flight").getAttribute("data-lives")).toBe("3")
  expect(await page.getByRole("textbox").inputValue()).toBe("")
})

test("round endings continue during composition, pause with Escape and allow immediate retry", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open("flight&fixture=flight-over")
  await page.waitForFunction(() => document.querySelector(".welcome-flight")?.getAttribute("data-phase") === "over")
  const canvas = page.locator(".welcome-game-canvas")
  const frame = () => canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  const first = await frame()
  await page.waitForTimeout(100)
  expect(await frame()).not.toBe(first)
  await page.getByRole("textbox").fill("Let the ending finish")
  const editing = await frame()
  await page.waitForTimeout(100)
  expect(await frame()).not.toBe(editing)
  await canvas.press("Escape")
  const paused = await frame()
  await page.waitForTimeout(180)
  expect(await frame()).toBe(paused)
  await canvas.click()
  expect(await page.locator(".welcome-flight").getAttribute("data-phase")).toBe("playing")
  expect(await page.locator(".welcome-flight").getAttribute("data-lives")).toBe("3")
})

test("retry blends into a fresh board, is interruptible and respects reduced motion", async () => {
  for (const motion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion: motion })
    await open("blocks&fixture=blocks-over")
    const canvas = page.locator(".welcome-game-canvas")
    const frame = () => canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
    await canvas.press("Space")
    expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("over")
    await canvas.press("r")
    const first = await frame()
    await page.waitForTimeout(320)
    const fresh = await frame()
    if (motion === "reduce") expect(fresh).toBe(first)
    else expect(fresh).not.toBe(first)
    expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("ready")
    expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("0")
    await canvas.press("r")
    await canvas.press("r")
    await canvas.press("Escape")
    const frozen = await frame()
    await page.waitForTimeout(180)
    expect(await frame()).toBe(frozen)
    expect(await page.getByRole("textbox").inputValue()).toBe("")
    expect(errors).toEqual([])
  }
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("completed feedback settles to a stable result and remount retains it", async () => {
  await page.setViewportSize({ width: 1100, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" })
  const captures = process.env.WELCOME_CAPTURE_DIR
  if (captures) await mkdir(captures, { recursive: true })
  for (const [scene, fixture, phase] of [
    ["flight", "flight-over", "over"],
    ["stack", "stack-result", "missed"],
    ["blocks", "blocks-over", "over"],
    ["slingshot", "sling-result", "won"],
  ]) {
    await open(`${scene}&fixture=${fixture}`)
    const canvas = page.locator(".welcome-game-canvas")
    if (scene === "blocks") await canvas.press("Space")
    await page.waitForFunction(
      ({ scene, phase }) => document.querySelector(`.welcome-${scene}`)?.getAttribute("data-phase") === phase,
      { scene, phase },
    )
    await page.waitForTimeout(1100)
    const frame = () => canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
    const completed = await frame()
    await page.waitForTimeout(100)
    expect(await frame()).toBe(completed)
    await canvas.dispatchEvent("keydown", { key: "r", repeat: true, bubbles: true })
    expect(await page.locator(`.welcome-${scene}`).getAttribute("data-phase")).toBe(phase)
    await page.getByRole("button", { name: "Mount", exact: true }).click()
    await page.getByRole("button", { name: "Mount", exact: true }).click()
    await canvas.waitFor()
    expect(await page.locator(`.welcome-${scene}`).getAttribute("data-phase")).toBe(phase)
    expect(await frame()).toBe(completed)
    if (captures) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".welcome-stage")!).opacity === "1")
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme })
        await page
          .locator(".session-workbench-pane")
          .screenshot({ path: path.join(captures, `${scene}-ending-${colorScheme}.png`) })
      }
      await page.emulateMedia({ colorScheme: "light" })
    }
    expect(await page.getByRole("textbox").inputValue()).toBe("")
    expect(errors).toEqual([])
  }
}, 20000)

test("blocks hold repeat, continuous touch movement, row clear and restart preserve the draft", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await open("blocks")
  const board = page.locator(".welcome-game-canvas")
  await board.focus()
  const first = Number(await page.locator(".welcome-blocks").getAttribute("data-column"))
  await page.keyboard.down("ArrowLeft")
  await page.waitForFunction(
    (column) => Number(document.querySelector(".welcome-blocks")?.getAttribute("data-column")) < column - 1,
    first,
  )
  expect(Number(await page.locator(".welcome-blocks").getAttribute("data-column"))).toBeLessThan(first - 1)
  await page.keyboard.up("ArrowLeft")
  await page.keyboard.press("Escape")
  await page.getByRole("textbox").fill("Keep this draft")
  await page.locator(".welcome-game-status").click()
  const box = (await board.boundingBox())!
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const before = Number(await page.locator(".welcome-blocks").getAttribute("data-column"))
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x + 60 }] })
  expect(Number(await page.locator(".welcome-blocks").getAttribute("data-column"))).toBeGreaterThan(before)
  await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
  expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("0")
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false })
  await touch.detach()
  expect(await page.getByRole("textbox").inputValue()).toBe("Keep this draft")
  await open("blocks&fixture=blocks-clear")
  await board.press("Space")
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("clearing")
  await page.waitForFunction(() => document.querySelector(".welcome-blocks")?.getAttribute("data-lines") === "1")
  await open("blocks&fixture=blocks-over")
  await board.press("Space")
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("over")
  await board.click()
  expect(await page.locator(".welcome-blocks").getAttribute("data-phase")).toBe("playing")
  expect(await page.locator(".welcome-blocks").getAttribute("data-locked")).toBe("0")
})

test("tower misses and exhausted slingshot rounds restart the same game without touching input", async () => {
  await page.setViewportSize({ width: 960, height: 920 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open("stack&fixture=stack-miss")
  await page.waitForFunction(() => document.querySelector(".welcome-stack")?.getAttribute("data-phase") === "missed")
  await page.locator(".welcome-game-canvas").click()
  expect(await page.locator(".welcome-stack").getAttribute("data-height")).toBe("0")
  await open("slingshot&fixture=sling-last")
  const canvas = page.locator(".welcome-game-canvas")
  await canvas.press("Space")
  await page.waitForFunction(
    () => document.querySelector(".welcome-slingshot")?.getAttribute("data-phase") === "lost",
    undefined,
    { timeout: 12000 },
  )
  await canvas.click()
  expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("3")
  expect(await page.locator(".welcome-slingshot").getAttribute("data-level")).toBe("0")
  await page.getByRole("textbox").fill("继续编辑正文")
  expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
}, 20000)

test("slingshot touch taps do not fire, pull cancellation preserves ammunition, and remount preserves flight", async () => {
  await page.setViewportSize({ width: 375, height: 700 })
  await open("slingshot")
  const canvas = page.locator(".welcome-game-canvas"),
    box = (await canvas.boundingBox())!
  const scale = Math.min(box.width / 720, box.height / 360)
  const point = {
    x: box.x + (box.width - 720 * scale) / 2 + 98 * scale,
    y: box.y + box.height - 360 * scale + 224 * scale,
  }
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("3")
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: point.x - 30, y: point.y + 24 }],
  })
  await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
  expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("3")
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false })
  await touch.detach()
  await canvas.press("Space")
  await canvas.press("Escape")
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  await page.getByRole("button", { name: "Mount", exact: true }).click()
  expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("2")
  expect(await page.locator(".welcome-slingshot").getAttribute("data-phase")).toBe("flying")
  expect(errors).toEqual([])
})

test("a second touch cannot replace or cancel the gesture already controlling a game", async () => {
  await page.setViewportSize({ width: 375, height: 700 })
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 })
  try {
    for (const scene of ["slingshot", "blocks", "flight"]) {
      await open(scene)
      const canvas = page.locator(".welcome-game-canvas"),
        box = (await canvas.boundingBox())!
      const scale = Math.min(box.width / 720, box.height / 360)
      const first = {
        id: 1,
        x: scene === "slingshot" ? box.x + (box.width - 720 * scale) / 2 + 98 * scale : box.x + box.width / 2,
        y: scene === "slingshot" ? box.y + box.height - 360 * scale + 224 * scale : box.y + box.height / 2,
      }
      const second = { ...first, id: 2, x: first.x + 14, y: first.y - 8 }
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] })
      const position = await canvas.getAttribute("aria-description")
      const column = scene === "blocks" ? Number(await page.locator(".welcome-blocks").getAttribute("data-column")) : 0
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] })
      if (scene === "flight") expect(await canvas.getAttribute("aria-description")).toBe(position)
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [second] })
      const moved = { ...first, x: first.x + (scene === "slingshot" ? -25 : 30), y: first.y + 25 }
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [moved] })
      if (scene === "blocks")
        expect(Number(await page.locator(".welcome-blocks").getAttribute("data-column"))).toBeGreaterThan(column)
      if (scene === "flight") expect(await canvas.getAttribute("aria-description")).not.toBe(position)
      await touch.send("Input.dispatchTouchEvent", {
        type: scene === "flight" ? "touchCancel" : "touchEnd",
        touchPoints: [],
      })
      expect(await page.locator(".welcome-stage").getAttribute("data-active")).toBe("")
      if (scene === "slingshot") expect(await page.locator(".welcome-slingshot").getAttribute("data-shots")).toBe("2")
      expect(errors).toEqual([])
    }
  } finally {
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false })
    await touch.detach()
  }
}, 20000)

test("touch-first play never names a click or a keyboard key", async () => {
  // The note's acceptance clause is about what the copy says under a coarse
  // pointer: touch players have neither hover nor a keyboard, so the status and
  // its help text must describe taps only. Both pointer kinds are exercised in
  // the same test so a regression on either branch is visible.
  for (const touch of [true, false]) {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      hasTouch: touch,
      isMobile: touch,
    })
    const local = await context.newPage()
    local.setDefaultTimeout(7000)
    try {
      await local.goto(`${url}?scene=stack`)
      await local.locator(".welcome-game-canvas").waitFor()
      await local.getByRole("button", { name: "Overlay", exact: true }).click()
      const status = local.locator(".welcome-game-status")
      const text = (await status.textContent()) ?? ""
      const label = (await status.getAttribute("aria-label")) ?? ""
      const help = (await local.locator(".welcome-game-status + .sr-only").textContent()) ?? ""
      if (touch) {
        expect(text).toContain("Tap to continue")
        expect(text).not.toContain("Click")
        expect(label).toContain("Tap to play or pause.")
        expect(help).not.toContain("Escape")
        expect(help).not.toContain("R restarts")
      } else {
        expect(text).toContain("Click to continue")
        expect(text).not.toContain("Tap")
        expect(label).toContain("Click to play or pause. Escape pauses; R restarts.")
        expect(help).toContain("Escape pauses. R restarts.")
      }
    } finally {
      await context.close()
    }
  }
}, 40_000)

test("a narrow greeting tightens its heading and drops the subtitle without touching desktop", async () => {
  // The stage is its own container, so the breakpoints follow the space the
  // greeting actually gets rather than the viewport alone. The desktop reading
  // is asserted in the same test so a change that shrinks both cannot pass.
  const measure = async (width: number, height: number) => {
    await page.setViewportSize({ width, height })
    await open("stack")
    return page.evaluate(() => {
      const stage = document.querySelector(".welcome-stage")!
      const heading = stage.querySelector(".welcome-scene-heading h1")!
      const subtitle = stage.querySelector(".welcome-scene-heading p")!
      return {
        stageWidth: Math.round(stage.getBoundingClientRect().width),
        heading: Number.parseFloat(getComputedStyle(heading).fontSize),
        subtitle: getComputedStyle(subtitle).display,
      }
    })
  }

  const phone = await measure(375, 812)
  expect(phone.stageWidth).toBeLessThanOrEqual(767)
  expect(phone.heading).toBeLessThanOrEqual(24)
  expect(phone.subtitle).toBe("none")

  const narrowest = await measure(320, 640)
  expect(narrowest.heading).toBeLessThanOrEqual(22)
  expect(narrowest.subtitle).toBe("none")

  const desktop = await measure(1440, 900)
  expect(desktop.stageWidth).toBeGreaterThan(767)
  expect(desktop.heading).toBeGreaterThanOrEqual(42)
  expect(desktop.subtitle).not.toBe("none")
  expect(errors).toEqual([])
}, 40_000)

test("a desktop viewport keeps the desktop heading even when the greeting pane is narrow", async () => {
  // The stage measures its own container, so a split view or an open sidebar can
  // leave it under 768 pixels while the viewport is still desktop. The mobile
  // typography must not follow the container alone, or a desktop pane shrinks
  // its heading and moves the playfield.
  const read = () =>
    page.evaluate(() => {
      const stage = document.querySelector(".welcome-stage")!
      const heading = stage.querySelector(".welcome-scene-heading h1")!
      const subtitle = stage.querySelector(".welcome-scene-heading p")!
      const canvas = document.querySelector(".welcome-game-canvas")!.getBoundingClientRect()
      return {
        stageWidth: Math.round(stage.getBoundingClientRect().width),
        heading: Number.parseFloat(getComputedStyle(heading).fontSize),
        subtitle: getComputedStyle(subtitle).display,
        canvasY: Math.round(canvas.y * 100) / 100,
        canvasHeight: Math.round(canvas.height * 100) / 100,
      }
    })

  await page.setViewportSize({ width: 1024, height: 900 })
  await open("stack")
  const wide = await read()
  expect(wide.stageWidth).toBeGreaterThan(767)
  expect(wide.heading).toBeGreaterThanOrEqual(32)

  // Same desktop viewport, but the pane is constrained below the mobile
  // breakpoint the way a side panel does.
  await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".session-workbench-pane")!
    pane.style.maxWidth = "700px"
  })
  await page.waitForTimeout(200)
  const narrowPane = await read()
  expect(narrowPane.stageWidth).toBeLessThanOrEqual(767)
  expect(await page.evaluate(() => window.innerWidth)).toBe(1024)
  // The desktop rule is `clamp(28px, 4.2cqw, 44px)`, so a narrower pane shrinks
  // the heading only as much as that formula says. Mobile typography (24px)
  // must not appear here, and the subtitle must stay readable.
  const baseHeading = Math.min(44, Math.max(28, 0.042 * narrowPane.stageWidth))
  expect(narrowPane.heading).toBeCloseTo(baseHeading, 1)
  expect(narrowPane.heading).toBeGreaterThan(24)
  expect(narrowPane.subtitle).not.toBe("none")
  expect(errors).toEqual([])
}, 40_000)
