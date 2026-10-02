import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

type Fixture = {
  detach(): void
  resize(): void
  fold(): void
  image(): void
  replaceOwner(): void
  facts(): { offset: number; scroll: number; folded: number; imageHeight: number }
}
let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const frames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
const facts = () => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.facts())

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".reading-anchor-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {createAutoScroll} from ${JSON.stringify(`/@fs/${path.resolve(appSrc, "../../../packages/ui/src/hooks/create-auto-scroll.tsx")}`)}
    import {captureConversationReadingAnchor} from ${JSON.stringify(`/@fs/${appSrc}/components/session/conversation-reading-anchor.ts`)}
    const [width,setWidth]=createSignal(800),[folded,setFolded]=createSignal(false),[owner,setOwner]=createSignal(1),[image,setImage]=createSignal(2)
    let viewport,marker,fold,img,auto
    const h=window.fixture={
      detach(){auto.handleInteraction();viewport.scrollTop=marker.offsetTop-viewport.offsetTop-50;auto.handleScroll()},
      resize(){setWidth(350)},fold(){setFolded(true)},image(){setImage(200)},replaceOwner(){setOwner(owner()+1)},
      facts(){return {offset:marker.getBoundingClientRect().top-viewport.getBoundingClientRect().top,scroll:viewport.scrollTop,folded:fold.getBoundingClientRect().height,imageHeight:img.naturalHeight}}
    }
    const src=()=>"data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="'+image()+'"></svg>')
    render(()=>{auto=createAutoScroll({working:()=>true,captureReadingAnchor(){const current=owner();return captureConversationReadingAnchor(viewport,()=>owner()===current)}});return <div ref={el=>{viewport=el;auto.scrollRef(el)}} onScroll={auto.handleScroll} style={{width:width()+"px",height:"400px",overflow:"auto"}}><div ref={auto.contentRef}>
      <div data-scroll-anchor="intro"><p>{"Long introductory text causes earlier content to wrap during workspace resizing. ".repeat(45)}</p></div>
      <img ref={el=>img=el} src={src()} style="width:100px;display:block"/>
      <div data-component="session-turn"><button data-scroll-anchor="process">Process</button>
      <div ref={el=>fold=el} style={{height:folded()?"0px":"160px",overflow:"hidden",transition:"height 240ms linear"}}>Execution process</div>
      <article data-scroll-anchor="answer"><p ref={el=>marker=el}>Current reading paragraph</p><p>{"Answer body. ".repeat(350)}</p></article></div>
    </div></div>},document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    optimizeDeps: { include: ["solid-js", "solid-js/web", "solid-js/store"], noDiscovery: true },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("detached reading survives workspace reflow, structural animation and a late image", async () => {
  await page.goto(base)
  await page
    .getByText("Current reading paragraph", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  await frames()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.detach())
  await frames()
  const original = (await facts()).offset
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resize())
  await frames()
  expect(Math.abs((await facts()).offset - original)).toBeLessThan(1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fold())
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().folded < 1)
  await frames()
  expect(Math.abs((await facts()).offset - original)).toBeLessThan(1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.image())
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().imageHeight === 200)
  await frames()
  expect(Math.abs((await facts()).offset - original)).toBeLessThan(1)
  expect(errors).toEqual([])
}, 30_000)

test("layout events from a released conversation cannot move the current viewport", async () => {
  await page.goto(base)
  await page.getByText("Current reading paragraph", { exact: true }).waitFor()
  await frames()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.detach())
  await frames()
  const original = (await facts()).scroll
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: Fixture }).fixture
    h.replaceOwner()
    h.resize()
  })
  await frames()
  expect((await facts()).scroll).toBe(original)
  expect(errors).toEqual([])
}, 30_000)
