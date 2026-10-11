import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
let server: ViteDevServer, browser: Browser, page: Page, directory: string, base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const frames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".conversation-presentation-"))
  await Bun.write(
    path.join(directory, "index.html"),
    `<!doctype html><style>
    [data-conversation-presentation]{position:relative;flex:1;overflow:hidden}[data-conversation-current]{position:relative;height:100%;display:flex;flex-direction:column}
    .fixture-column{display:flex;flex-direction:column;align-items:flex-start;gap:20px;width:100%}#flow [data-conversation-viewport]{height:300px;width:100%;overflow:auto}#flow .w-full{width:100%}
    </style><div id="presentation" style="height:400px;display:flex"></div><div id="flow" style="width:500px;height:300px"></div><script type="module" src="/main.tsx"></script>`,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from ${JSON.stringify(`/@fs/${path.resolve(appSrc, "../../../packages/ui/src/testing/i18n.tsx")}`)}
    import {createAutoScroll} from ${JSON.stringify(`/@fs/${path.resolve(appSrc, "../../../packages/ui/src/hooks/create-auto-scroll.tsx")}`)}
    import {ConversationPresentation} from ${JSON.stringify(`/@fs/${appSrc}/components/session/conversation-presentation.tsx`)}
    import {ConversationViewport} from ${JSON.stringify(`/@fs/${appSrc}/components/session/conversation-viewport.tsx`)}
    const [session,setSession]=createSignal("A"),[accepted,setAccepted]=createSignal("A"),[scope,setScope]=createSignal("scope"),[route,setRoute]=createSignal()
    let leaves=0
    window.presentation={select(id){setSession(id)},admit(id){setAccepted(id)},scope(id){setScope(id)},promote(){setRoute(session())},leaves(){return leaves}}
    if(location.search!=="?flow") render(()=><I18nProvider i18n={setupI18n()}><ConversationPresentation owner={["server",scope(),route()??session()]} ready={accepted()===session()} onLeave={()=>leaves++}>
      <header>Title {session()}</header><div style="height:300px;overflow:auto"><article style="height:800px"><p id="live-id">Body {session()}</p></article></div>
    </ConversationPresentation></I18nProvider>,document.getElementById("presentation"))
    else render(()=>{const scroll=createAutoScroll({working:()=>false});return <I18nProvider i18n={setupI18n()}><ConversationViewport ready={true} scrolledUp={false} onScrolledUpChange={()=>{}} autoScroll={scroll} setScrollRef={scroll.scrollRef} contentClass="fixture-column"><article style="width:100%"><p>{"A naturally wrapping conversation paragraph. ".repeat(25)}</p></article></ConversationViewport></I18nProvider>},document.getElementById("flow"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    resolve: { alias: { "@": appSrc } },
    plugins: [solid()],
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), directory] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", (e) => errors.push(e.message))
}, 30000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 15000)
type Presentation = {
  select(id: string): void
  admit(id: string): void
  scope(id: string): void
  promote(): void
  leaves(): number
}
const presentation = (action: "select" | "admit" | "scope", value: string) =>
  page.evaluate(
    ({ action, value }) => (window as unknown as { presentation: Presentation }).presentation[action](value),
    { action, value },
  )

test("promoting a captured conversation to the same route preserves its admission", async () => {
  await page.goto(base + "?presentation")
  await page.getByText("Body A", { exact: true }).waitFor()
  await frames()
  const leaves = await page.evaluate(() => (window as unknown as { presentation: Presentation }).presentation.leaves())
  await page.evaluate(() => (window as unknown as { presentation: Presentation }).presentation.promote())
  await frames()
  expect(await page.evaluate(() => (window as unknown as { presentation: Presentation }).presentation.leaves())).toBe(
    leaves,
  )
  expect(await page.locator("[data-conversation-retained]").textContent()).toBe("")
  expect(await page.locator("[data-conversation-current]").evaluate((element) => (element as HTMLElement).inert)).toBe(
    false,
  )
  expect(errors).toEqual([])
})

test("session presentation keeps one inert outgoing picture through slow and superseded navigation", async () => {
  await page.goto(base + "?presentation")
  await page.getByText("Body A", { exact: true }).waitFor()
  await frames()
  await presentation("select", "B")
  const retained = page.locator("[data-conversation-retained]")
  expect(await retained.textContent()).toContain("Body A")
  expect(await retained.locator("[id]").count()).toBe(0)
  expect(
    await page
      .locator("[data-conversation-current]")
      .last()
      .evaluate((el) => (el as HTMLElement).inert),
  ).toBe(true)
  await page.locator("[data-conversation-switching]").waitFor()
  await presentation("select", "C")
  await presentation("admit", "B")
  await frames()
  expect(await retained.textContent()).toContain("Body A")
  expect(await retained.locator(":scope > div").count()).toBe(1)
  await presentation("admit", "C")
  await page.waitForFunction(() => !document.querySelector("[data-conversation-retained]")?.childElementCount)
  expect(await page.locator("[data-conversation-current]").textContent()).toContain("Body C")
  expect(await page.locator("[data-conversation-current]").evaluate((el) => (el as HTMLElement).inert)).toBe(false)
  expect(errors).toEqual([])
})

test("reduced motion retains loading continuity and a Scope boundary removes the old picture", async () => {
  await page.goto(base + "?presentation")
  await page.getByText("Body A", { exact: true }).waitFor()
  await frames()
  await presentation("select", "B")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await frames()
  expect(await page.locator("[data-conversation-retained]").textContent()).toContain("Body A")
  await presentation("admit", "B")
  await page.waitForFunction(() => !document.querySelector("[data-conversation-retained]")?.childElementCount)
  expect(await page.locator("[data-conversation-current]").evaluate((el) => el.getAnimations().length)).toBe(0)
  await presentation("select", "C")
  await presentation("scope", "another-scope")
  expect(await page.locator("[data-conversation-retained]").textContent()).toBe("")
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("admission keeps one opaque transcript through immediate follow-up navigation", async () => {
  await page.goto(base + "?presentation")
  await page.getByText("Body A", { exact: true }).waitFor()
  await frames()
  await presentation("select", "B")
  const admission = await page.evaluate(async () => {
    const fixture = (window as unknown as { presentation: Presentation }).presentation
    fixture.admit("B")
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const live = document.querySelector<HTMLElement>("[data-conversation-current]")!
    const animations = live.getAnimations()
    for (const animation of animations) {
      animation.pause()
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    }
    return {
      oldBody: document.querySelector("[data-conversation-retained]")!.textContent,
      currentBody: live.textContent,
      opacity: getComputedStyle(live).opacity,
      inert: live.inert,
    }
  })
  expect(admission.oldBody).toBe("")
  expect(admission.currentBody).toContain("Body B")
  expect(admission.opacity).toBe("1")
  expect(admission.inert).toBe(false)
  await presentation("select", "C")
  expect(await page.locator("[data-conversation-retained]").textContent()).toContain("Body B")
  expect(await page.locator("[data-conversation-retained]").textContent()).not.toContain("Body A")
  await presentation("admit", "C")
  await frames()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await frames()
  expect(await page.locator("[data-conversation-retained]").textContent()).toBe("")
  expect(await page.locator("[data-conversation-current]").evaluate((el) => el.getAnimations().length)).toBe(0)
  expect(await page.locator("[data-conversation-current]").textContent()).toContain("Body C")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  expect(errors).toEqual([])
})

test("the motion layer fills a start-aligned flex conversation column without collapsing prose width", async () => {
  await page.goto(base + "?flow")
  const article = page.locator("#flow article")
  await article.waitFor()
  const bounds = await article.boundingBox()
  expect(bounds!.width).toBeGreaterThanOrEqual(498)
  expect(bounds!.height).toBeLessThan(1000)
  expect(
    await page.locator("#flow [data-conversation-viewport]").evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)
})
