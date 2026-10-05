import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { domFixture } from "../support/dom-fixtures"

let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(await domFixture("render-session.dom")))
  const styles = [...new Bun.Glob("*.css").scanSync({ cwd: directory })]
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/")
        return new Response(
          `<!doctype html><head>${styles}<style>body { margin: 24px; font: 16px/1.5 sans-serif; } #root { max-width: 760px; margin: auto; } </style></head><body><div id="root"></div><script>globalThis.process = { env: { NODE_ENV: "test" } }</script><script type="module" src="/render-session.dom.js"></script></body>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(Bun.file(path.join(directory, pathname)))
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.stack)
  })
  await page.goto(server.url.href, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForFunction(() => !!(window as unknown as { __chronologyHarness: unknown }).__chronologyHarness)
}, 120000)

afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

async function visual(html: string, title = "Evidence at a glance") {
  await page.evaluate(
    ({ html, title }) => {
      const harness = (
        window as unknown as {
          __chronologyHarness: { setRender: (html: string, title: string) => void }
        }
      ).__chronologyHarness
      harness.setRender(html, title)
    },
    { html, title },
  )
  await page.frameLocator('[data-component="render-html"] iframe').locator("body").waitFor()
  await page.waitForTimeout(150)
}
const frame = () => page.locator('[data-component="render-html"] iframe').first()

// These use the real SessionTurn and standard tool renderer, not a substitute card.
test("presents a visual between prose without a generic tool disclosure", async () => {
  await visual('<p id="result">Readable result</p>')
  expect(await page.locator('[data-component="render-tool"]').count()).toBe(1)
  expect(await page.locator('[data-component="render-tool"] [data-component="collapsible"]').count()).toBe(0)
  expect(await frame().getAttribute("title")).toBe("Evidence at a glance")
  expect(await frame().boundingBox()).toBeTruthy()
  expect(await page.getByText("Here is the comparison.", { exact: true }).isVisible()).toBe(true)
  expect(await page.locator("body").innerText()).toContain("The visual stays in the conversation.")
})

test("fits short content and can shrink after tall content or width changes", async () => {
  await visual('<div style="height:400px">Tall result</div>')
  expect((await frame().boundingBox())!.height).toBeGreaterThan(400)
  await visual('<p id="short">Short result</p>')
  expect((await frame().boundingBox())!.height).toBeLessThan(140)
  await visual(`<p>${"Responsive content ".repeat(90)}</p>`)
  await page.setViewportSize({ width: 375, height: 800 })
  await page.waitForTimeout(150)
  const narrow = (await frame().boundingBox())!.height
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(150)
  expect((await frame().boundingBox())!.height).toBeLessThan(narrow)
})

test("fullbleed content fits the frame without clipping or double padding", async () => {
  for (const html of [
    '<div data-render-fullbleed style="height:150px; width:100%">Full width</div>',
    '<style>.visual { height:150px; width:100% }</style><div class="visual" data-render-fullbleed>Full width</div>',
    '<html><head><style>.visual { height:150px; width:100% }</style></head><body><div class="visual" data-render-fullbleed>Full width</div></body></html>',
  ]) {
    await visual(html)
    const metrics = await frame().evaluate((element) => {
      const iframe = element as HTMLIFrameElement
      const root = iframe.contentDocument!.querySelector("[data-render-fullbleed]")!.getBoundingClientRect()
      return {
        left: root.left,
        top: root.top,
        width: root.width,
        frame: iframe.clientWidth,
        height: iframe.clientHeight,
      }
    })
    expect(metrics.left).toBe(0)
    expect(metrics.top).toBe(0)
    expect(metrics.width).toBe(metrics.frame)
    expect(metrics.height).toBe(150)
  }
})

test("theme updates repaint the existing document and retain native disclosure and scroll", async () => {
  await visual(
    '<details id="detail"><summary>More</summary><p>Retained detail</p></details><div style="height:900px">Long result</div>',
  )
  await frame().evaluate((element) => {
    const doc = (element as HTMLIFrameElement).contentDocument!
    doc.querySelector("details")!.open = true
    doc.scrollingElement!.scrollTop = 120
    ;(element as HTMLIFrameElement & { retainedDocument: Document }).retainedDocument = doc
  })
  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "dark"
    document.documentElement.style.setProperty("--text-base", "rgb(220, 230, 240)")
    document.dispatchEvent(new Event("synergy:theme-change"))
  })
  await page.waitForTimeout(150)
  const retained = await frame().evaluate((element) => {
    const iframe = element as HTMLIFrameElement & { retainedDocument: Document }
    const doc = iframe.contentDocument!
    return {
      same: doc === iframe.retainedDocument,
      open: doc.querySelector("details")!.open,
      scroll: doc.scrollingElement!.scrollTop,
      color: doc.defaultView!.getComputedStyle(doc.body).color,
    }
  })
  expect(retained.same).toBe(true)
  expect(retained.open).toBe(true)
  expect(retained.scroll).toBe(120)
  expect(retained.color).toBe("rgb(220, 230, 240)")
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--text-base", "rgb(210, 220, 230)")
    document.documentElement.style.setProperty("--font-family-sans", '"Georgia", serif')
    document.dispatchEvent(new Event("synergy:theme-change"))
    document.dispatchEvent(new Event("synergy:font-change"))
  })
  await page.waitForTimeout(150)
  expect(
    await frame().evaluate(
      (element) =>
        (element as HTMLIFrameElement).contentDocument ===
        (element as HTMLIFrameElement & { retainedDocument: Document }).retainedDocument,
    ),
  ).toBe(true)
  const finalTheme = await frame().evaluate((element) => {
    const doc = (element as HTMLIFrameElement).contentDocument!
    const style = doc.defaultView!.getComputedStyle(doc.body)
    return { color: style.color, font: style.fontFamily }
  })
  expect(finalTheme.color).toBe("rgb(210, 220, 230)")
  expect(finalTheme.font).toContain("Georgia")
})

test("theme and font updates during document loading use the latest host values", async () => {
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--text-base", "rgb(100, 110, 120)")
    document.documentElement.style.setProperty("--font-family-sans", '"Arial", sans-serif')
  })
  await visual("<p>Previous document</p>")
  await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: { setRender: (html: string) => void } })
      .__chronologyHarness
    harness.setRender('<p id="loading-theme">New document</p>')
    document.documentElement.style.setProperty("--text-base", "rgb(120, 130, 140)")
    document.documentElement.style.setProperty("--font-family-sans", '"Georgia", serif')
    document.dispatchEvent(new Event("synergy:theme-change"))
    document.dispatchEvent(new Event("synergy:font-change"))
  })
  await page.frameLocator('[data-component="render-html"] iframe').locator("#loading-theme").waitFor()
  const theme = await frame().evaluate((element) => {
    const doc = (element as HTMLIFrameElement).contentDocument!
    const style = doc.defaultView!.getComputedStyle(doc.body)
    return { color: style.color, font: style.fontFamily }
  })
  expect(theme.color).toBe("rgb(120, 130, 140)")
  expect(theme.font).toContain("Georgia")
})

test("static MathML integration content retains native disclosure interaction", async () => {
  await visual("<math><mtext><details><summary>Formula detail</summary>Preserved detail</details></mtext></math>")
  const current = page.frameLocator('[data-component="render-html"] iframe')
  await current.getByText("Formula detail", { exact: true }).click()
  expect(await current.locator("details").getAttribute("open")).not.toBeNull()
})

test("missing HTML keeps long fallback output readable", async () => {
  const output = "Recorded output ".repeat(100)
  await page.evaluate((output) => {
    const harness = (
      window as unknown as {
        __chronologyHarness: { setRender: (html: string, title: string, status: string, output: string) => void }
      }
    ).__chronologyHarness
    harness.setRender("", "Fallback result", "completed", output)
  }, output)
  const disclosure = page.locator('[data-tool-status="completed"] button[aria-expanded]')
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") await disclosure.click()
  const result = page.locator('[data-component="tool-output-text"]')
  await result.waitFor()
  expect(await result.textContent()).toBe(output)
  const metrics = await result.evaluate((element) => ({
    whiteSpace: getComputedStyle(element).whiteSpace,
    scroll: element.scrollWidth,
    width: element.clientWidth,
  }))
  expect(metrics.whiteSpace).toBe("pre-wrap")
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1)
})

test("keeps large visuals bounded and opens an accessible viewer with focus return", async () => {
  await visual('<div style="height:1200px">Large result</div>')
  expect((await frame().boundingBox())!.height).toBeLessThanOrEqual(480)
  const expand = page.getByRole("button", { name: "Expand visual" })
  await expand.focus()
  await expand.press("Enter")
  await page.getByRole("dialog", { name: "Evidence at a glance" }).waitFor()
  await page.keyboard.press("Tab")
  expect(await page.getByRole("dialog").evaluate((element) => element.contains(document.activeElement))).toBe(true)
  expect(await page.locator('[data-component="render-html"] iframe').count()).toBe(2)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(250)
  expect(await page.getByRole("dialog").count()).toBe(0)
  expect(await expand.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await page.locator('[data-component="render-html"] iframe').count()).toBe(1)
})

test("blocks malformed-document resource loads and HTML/SVG/MathML navigation in both presentations", async () => {
  const requests: string[] = []
  const denied = /render-invalid\.example|render-denied/
  await page.route(denied, async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  const content = `<meta http-equiv="refresh" content="0;url=/render-denied/refresh"><script>parent.document.body.dataset.compromised = 'true'</script><img src="https://render-invalid.example/image"><style>@import url("https://render-invalid.example/style"); #safe { color: var(--render-text-strong); }</style><form action="/render-denied/form"><button>Submit</button></form><a id="html-link" href="/render-denied/link" tabindex="0" target="_self" ping="https://render-invalid.example/ping">Leave visual</a><svg width="240" height="70"><defs><rect id="shape" width="20" height="20" /></defs><use href="#shape" /><a href="https://render-invalid.example/svg"><text x="25" y="20">SVG link</text></a><a xlink:href="/render-denied/svg"><text x="25" y="40">SVG legacy</text><set attributeName="href" to="/render-denied/smil" /></a></svg><math href="https://render-invalid.example/math"><mi id="math-link" href="/render-denied/math" tabindex="0">x</mi><mo xlink:href="/render-denied/math-legacy">+</mo><mn>1</mn></math><details><summary>More</summary><p>Preserved native detail</p></details><p id="safe">Safe result</p>`
  try {
    for (const html of [
      content,
      `<!-- <head> -->${content}`,
      `<html><img src="https://render-invalid.example/early"><head><style>p { font-weight: 500; }</style></head><body>${content}</body></html>`,
    ]) {
      await visual(html)
      for (const expanded of [false, true]) {
        if (expanded) {
          await page.getByRole("button", { name: "Expand visual" }).click()
          await page.getByRole("dialog").waitFor()
        }
        const current = page.frameLocator('[data-component="render-html"] iframe').last()
        await current.locator("#safe").waitFor()
        await current.getByText("Leave visual").click()
        await current.getByText("Leave visual").press("Enter")
        await current.getByText("Leave visual").click({ button: "middle" })
        await current.getByText("SVG link", { exact: true }).click()
        await current.getByText("SVG legacy", { exact: true }).click()
        await current.locator("#math-link").click()
        await current.locator("#math-link").press("Enter")
        expect(await current.locator("math [href], math [xlink\\:href], math[href]").count()).toBe(0)
        await current.getByText("Submit", { exact: true }).click()
        const open = await current.locator("details").getAttribute("open")
        await current.locator("summary").click()
        expect((await current.locator("details").getAttribute("open")) !== null).toBe(open === null)
        expect(await current.locator("use").getAttribute("href")).toBe("#shape")
        expect(await current.locator("form, script, meta[http-equiv=refresh], set").count()).toBe(0)
        expect(await current.locator("#html-link").getAttribute("href")).toBeNull()
        expect(await current.locator("#safe").count()).toBe(1)
        if (expanded) {
          await page.keyboard.press("Escape")
          await page.getByRole("dialog").waitFor({ state: "hidden" })
        }
      }
    }
    expect(await page.locator("body").getAttribute("data-compromised")).toBeNull()
    expect(requests).toEqual([])
  } finally {
    await page.unroute(denied)
  }
}, 20000)

test("narrow viewport and reduced motion keep the visual and viewer controls reachable", async () => {
  await page.setViewportSize({ width: 320, height: 600 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await visual("<p>Phone width</p>", "A long visual title that must wrap rather than displace the action")
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  const expand = page.getByRole("button", { name: "Expand visual" })
  await expand.click()
  await page.waitForTimeout(150)
  const close = page.getByRole("button", { name: "Close dialog" })
  expect(await close.isVisible()).toBe(true)
  const box = (await close.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(320)
  await close.click()
  expect(errors).toEqual([])
})
