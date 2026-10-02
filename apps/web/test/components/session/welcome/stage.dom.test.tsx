import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
    '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { LocaleProvider } from "${source}/context/locale"
    import { WelcomeStage } from "${source}/components/session/welcome/stage"
    import { createWelcomeMemory } from "${source}/components/session/welcome/types"
    import { welcomeScenes } from "${source}/components/session/welcome/registry"
    import { handleComposerTypingAutofocus } from "${source}/components/prompt-input/typing-autofocus"
    import "@ericsanchezok/synergy-ui/styles"
    import "${source}/index.css"
    let resolveLate
    const late = {id:"late", title:{id:"fixture.late",message:"Late"}, load:() => new Promise(resolve => {resolveLate=resolve})}
    const fourth = {id:"fourth", title:{id:"fixture.fourth",message:"Fourth"}, load:async() => ({default:() => <button>Fourth scene works</button>})}
    function App() {
      const [definition, setDefinition] = createSignal(welcomeScenes.find(s => s.id === new URLSearchParams(location.search).get("scene")) ?? welcomeScenes[0])
      const [memory, setMemory] = createSignal(createWelcomeMemory())
      const [blocked, setBlocked] = createSignal(false)
      const [shown, setShown] = createSignal(true)
      let input
      document.addEventListener("keydown", e => handleComposerTypingAutofocus(e, input, blocked()))
      const select = value => {setMemory(createWelcomeMemory()); setDefinition(value)}
      return <><div class="fixture-controls"><button onClick={()=>select(late)}>Load late</button><button onClick={()=>select(fourth)}>Load fourth</button><button onClick={()=>resolveLate?.({default:()=> <div>Obsolete scene</div>})}>Resolve late</button><button onClick={()=>setBlocked(!blocked())}>Overlay</button><button onClick={()=>setShown(!shown())}>Mount</button></div>
        <div class="session-workbench-pane" style="height:calc(100dvh - 36px);display:flex;flex-direction:column">
          <main style="flex:1;min-height:0;overflow:auto"><div class="session-content-column" style="padding-top:20px;padding-bottom:20px"><Show when={shown()}><WelcomeStage definition={definition()} memory={memory()} seed={8} blocked={blocked()} disabled={false} brand={<b>Synergy</b>} onStart={text=>{input.value=text;input.focus()}} /></Show></div></main>
          <div class="session-composer"><textarea ref={input} data-component="prompt-input" aria-label="Message" style="height:96px;width:100%" /></div>
        </div></>
    }
    render(() => <LocaleProvider><App /></LocaleProvider>, document.getElementById("root"))
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
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
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

test("narrow and short layouts keep the editor and scene controls reachable", async () => {
  for (const width of [320, 375, 720]) {
    await page.setViewportSize({ width, height: 580 })
    await open()
    await page.getByRole("button", { name: "Make my own version" }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const box = await page.getByRole("textbox").boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(581)
    expect(errors).toEqual([])
  }
})
