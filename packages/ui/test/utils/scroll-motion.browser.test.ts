import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import path from "node:path"

let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/utils/scroll-motion.ts")],
    target: "browser",
  })
  expect(build.success).toBe(true)
  const script = await build.outputs[0].text()
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        `<!doctype html><style>
    #viewport {height:100px;width:300px;overflow:auto} #content {overflow:clip} #target {height:300px} #anchor {padding-top:200px}
    </style><div id="viewport"><div id="content"><div id="target"><div id="anchor">Stable paragraph</div></div></div></div>
    <script type="module">${script.replace(/export\s*\{[^}]*\};?\s*$/, "")}
    const viewport=document.querySelector('#viewport'), target=document.querySelector('#target');
    window.motion=createScrollMotion(()=>target); window.motion.move(viewport, viewport.scrollHeight, false);
    </script>`,
        { headers: { "content-type": "text/html" } },
      ),
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 30000)
afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

test("growth pins canonical geometry while preserving the painted paragraph, retargets and yields to reading", async () => {
  await page.goto(server.url.href)
  await page.waitForFunction(() => !!(window as unknown as { motion: unknown }).motion)
  const result = await page.evaluate(async () => {
    const motion = (
      window as unknown as {
        motion: { move(v: HTMLElement, top: number, animate: boolean): void; interrupt(v: HTMLElement): void }
      }
    ).motion
    const viewport = document.querySelector<HTMLElement>("#viewport")!
    const target = document.querySelector<HTMLElement>("#target")!
    const anchor = document.querySelector<HTMLElement>("#anchor")!
    const y = () => anchor.getBoundingClientRect().top
    const before = y()
    target.style.height = "332px"
    motion.move(viewport, viewport.scrollHeight, true)
    const first = { y: y(), top: viewport.scrollTop, height: viewport.scrollHeight }
    await new Promise((resolve) => setTimeout(resolve, 60))
    const intermediate = y()
    target.style.height = "364px"
    motion.move(viewport, viewport.scrollHeight, true)
    const retargeted = y()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const interruptedFrom = y()
    motion.interrupt(viewport)
    return {
      before,
      first,
      intermediate,
      retargeted,
      interruptedFrom,
      after: y(),
      remaining: target.getAnimations().length,
    }
  })
  expect(result.first.top).toBe(232)
  expect(result.first.height).toBe(332)
  expect(Math.abs(result.before - result.first.y)).toBeLessThan(1)
  expect(result.intermediate).toBeLessThan(result.before)
  expect(Math.abs(result.intermediate - result.retargeted)).toBeLessThan(1)
  expect(Math.abs(result.interruptedFrom - result.after)).toBeLessThan(1)
  expect(result.remaining).toBe(0)
})

test("a dynamic reduced-motion preference settles a running transition", async () => {
  await page.goto(server.url.href)
  await page.waitForFunction(() => !!(window as unknown as { motion: unknown }).motion)
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>("#viewport")!
    document.querySelector<HTMLElement>("#target")!.style.height = "332px"
    ;(window as unknown as { motion: { move(v: HTMLElement, top: number, animate: boolean): void } }).motion.move(
      viewport,
      viewport.scrollHeight,
      true,
    )
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForFunction(() => document.querySelector("#target")!.getAnimations().length === 0)
  expect(await page.locator("#viewport").evaluate((node) => node.scrollTop)).toBe(232)
})
