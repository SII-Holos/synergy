import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser, page: Page, server: ViteDevServer, cache: string
const errors: string[] = []
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "composer-motion-test-"))
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      tailwind(),
      {
        name: "composer-motion-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end(
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/composer-motion.tsx"></script>',
            )
          })
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dir, "../../../src"),
        "lucide-solid": Bun.resolveSync("lucide-solid", path.resolve(import.meta.dir, "../../../../../packages/ui")),
      },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "marked", "dompurify", "lucide-solid"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/composer-motion.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 960, height: 800 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(40_000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(server.resolvedUrls!.local[0]!, { timeout: 40_000 })
  await page.getByRole("textbox", { name: "Message" }).waitFor()
  expect(errors).toEqual([])
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

async function toggleAndPause() {
  await page
    .locator(".session-composer")
    .waitFor()
    .catch((error: unknown) => {
      throw new Error([String(error), ...errors].join("\n"))
    })
  return page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>(".session-composer")!
    const before = root.getBoundingClientRect().toJSON()
    root.querySelector<HTMLButtonElement>(".composer-expand-control")!.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const column = root.closest<HTMLElement>(".session-prompt-dock-content")!
    const animations = column.getAnimations({ subtree: true })
    for (const animation of animations) animation.pause()
    const sizing = root
      .getAnimations()
      .find((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => "height" in frame))
    if (!sizing)
      return {
        before,
        start: root.getBoundingClientRect().toJSON(),
        middle: root.getBoundingClientRect().toJSON(),
        animation: false,
      }
    for (const animation of animations) animation.currentTime = 0
    const start = root.getBoundingClientRect().toJSON()
    const toolsStart = root
      .querySelector<HTMLElement>(".composer-long-tools-presence")!
      .getBoundingClientRect()
      .toJSON()
    for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    return {
      before,
      start,
      middle: root.getBoundingClientRect().toJSON(),
      toolsStart,
      toolsMiddle: root.querySelector<HTMLElement>(".composer-long-tools-presence")!.getBoundingClientRect().toJSON(),
      animation: true,
    }
  })
}
async function finish() {
  await page.locator(".session-prompt-dock-content").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish()
  })
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
}

test("the empty editor stays readable and can resize and expand inside conversation presentation", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?empty`)
  const body = page.locator(".session-composer-editor")
  await page.getByRole("textbox", { name: "Message" }).waitFor()
  const initial = (await body.boundingBox())!
  const placeholder = (await page.getByText("Describe a task", { exact: true }).boundingBox())!
  expect(initial.height).toBe(64)
  expect(placeholder.y).toBeGreaterThanOrEqual(initial.y)
  expect(placeholder.y + placeholder.height).toBeLessThanOrEqual(initial.y + initial.height)

  const handle = page.getByRole("separator", { name: "Resize editor" })
  const grip = (await handle.boundingBox())!
  const x = grip.x + grip.width / 2
  const y = grip.y + grip.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 160, { steps: 8 })
  await page.mouse.up()
  expect((await body.boundingBox())!.height).toBe(initial.height + 160)

  await page.getByRole("button", { name: "Expand editor" }).focus()
  await page.keyboard.press("Enter")
  await finish()
  expect((await body.boundingBox())!.height).toBeGreaterThan(400)
  const send = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!
  expect(send.y + send.height).toBeLessThanOrEqual(800)
  await page.keyboard.press("Escape")
  await finish()
  expect((await body.boundingBox())!.height).toBe(initial.height + 160)
  await page.goto(server.resolvedUrls!.local[0]!)
})

test("retaining an outgoing conversation does not replace the current header's height measurement", async () => {
  await page.reload()
  await page.getByRole("button", { name: "Switch conversation" }).click()
  await page.locator("[data-conversation-retained] > div").waitFor()
  await page.setViewportSize({ width: 960, height: 820 })
  try {
    await page.getByRole("button", { name: "Expand editor" }).focus()
    await page.keyboard.press("Enter")
    await finish()
    const composer = (await page.locator(".session-composer").boundingBox())!
    const header = (await page.locator("[data-conversation-current] [data-session-top-bar]").boundingBox())!
    expect(composer.height).toBeGreaterThan(500)
    expect(composer.y).toBeGreaterThanOrEqual(header.y + header.height)
    expect(composer.y - header.y - header.height).toBeLessThan(20)
    await page.getByRole("button", { name: "Admit conversation" }).click()
    await page.waitForFunction(() => !document.querySelector("[data-conversation-retained]")?.childElementCount)
    expect((await page.locator(".session-composer").boundingBox())!.height).toBe(composer.height)
  } finally {
    await page.setViewportSize({ width: 960, height: 800 })
    await page.goto(server.resolvedUrls!.local[0]!)
  }
})

test("expansion grows from the visible size, keeps its bottom anchor and smoothly shares width with preview", async () => {
  const editor = await page.getByRole("textbox", { name: "Message" }).elementHandle()
  const transition = await toggleAndPause()
  expect(transition.animation).toBe(true)
  expect(transition.start.height).toBeCloseTo(transition.before.height, 0)
  expect(transition.middle.height).toBeGreaterThan(transition.before.height)
  expect(transition.middle.bottom).toBeCloseTo(transition.before.bottom, 0)
  expect(transition.middle.width).toBeGreaterThan(transition.before.width)
  await finish()
  const final = await page.locator(".session-composer").boundingBox()
  expect(transition.middle.height).toBeLessThan(final!.height)
  expect(await editor!.evaluate((element) => element === document.querySelector('[role="textbox"]'))).toBe(true)
  expect(await page.locator("#mounts").textContent()).toBe("1")
})

test("collapse keeps the Send action at the bottom and preserves native selection, scrolling and undo", async () => {
  await page.reload()
  const editor = page.getByRole("textbox", { name: "Message" })
  await editor.press("ControlOrMeta+End")
  await editor.pressSequentially("undo marker")
  const edited = await editor.textContent()
  await editor.press("Shift+ArrowLeft")
  await editor.press("Shift+ArrowLeft")
  const selected = await page.evaluate(() => window.getSelection()?.toString())
  await toggleAndPause()
  await finish()
  await page.locator(".session-composer-editor").evaluate((element) => {
    element.scrollTop = 80
  })
  const sendBottom = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!.y
  const transition = await toggleAndPause()
  expect(transition.animation).toBe(true)
  expect(transition.middle.height).toBeLessThan(transition.before.height)
  expect(await page.locator(".composer-long-preview").evaluate((element) => (element as HTMLElement).inert)).toBe(true)
  expect((await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!.y).toBeCloseTo(sendBottom, 0)
  await finish()
  expect(await editor.textContent()).toBe(edited)
  expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
  expect(await page.locator(".session-composer-editor").evaluate((element) => element.scrollTop)).toBe(80)
  await editor.press("ControlOrMeta+z")
  expect(await editor.textContent()).not.toContain("undo marker")
  expect(await page.locator("#mounts").textContent()).toBe("1")
})

test("typing during expansion settles the layout without losing the new draft or native undo", async () => {
  await page.reload()
  await toggleAndPause()
  const editor = page.getByRole("textbox", { name: "Message" })
  await editor.press("ControlOrMeta+End")
  await editor.pressSequentially("during transition")
  expect(await page.locator(".session-composer").getAttribute("data-motion")).toBeNull()
  expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()
  expect(await editor.textContent()).toContain("during transition")
  await editor.press("ControlOrMeta+z")
  expect(await editor.textContent()).not.toContain("during transition")
  expect(await page.locator("#mounts").textContent()).toBe("1")
})

test("reversing an in-flight expansion starts from its current visible geometry", async () => {
  await page.reload()
  const expanding = await toggleAndPause()
  expect(expanding.animation).toBe(true)
  const collapsing = await toggleAndPause()
  expect(collapsing.animation).toBe(true)
  expect(collapsing.start.height).toBeCloseTo(expanding.middle.height, 0)
  expect(collapsing.start.width).toBeCloseTo(expanding.middle.width, 0)
  expect(collapsing.toolsStart!.top).toBeCloseTo(expanding.toolsMiddle!.top, 1)
  await finish()
  expect(await page.locator(".session-composer").getAttribute("data-expanded")).toBeNull()
  expect(await page.locator("#mounts").textContent()).toBe("1")
})

test("reduced motion settles immediately, including a preference change during expansion", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  try {
    await page.reload()
    await page.getByRole("button", { name: "Expand editor" }).click()
    expect(await page.locator(".session-composer").evaluate((element) => element.getAnimations().length)).toBe(0)
    expect(await page.locator(".session-composer").getAttribute("data-motion")).toBeNull()
    await page.getByRole("button", { name: "Collapse editor" }).click()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    const expanding = await toggleAndPause()
    expect(expanding.animation).toBe(true)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
    expect(await page.locator(".session-composer").evaluate((element) => element.getAnimations().length)).toBe(0)
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" })
  }
})

test("manual sizing and viewport changes cancel stale dimensions; unmount releases animation work", async () => {
  await page.reload()
  await toggleAndPause()
  await finish()
  await toggleAndPause()
  await page.getByRole("button", { name: "Resize body" }).click()
  expect(await page.locator(".session-composer").getAttribute("data-motion")).toBeNull()
  expect((await page.locator(".session-composer-editor").boundingBox())!.height).toBe(180)
  await toggleAndPause()
  await page.setViewportSize({ width: 375, height: 480 })
  await page.waitForFunction(() => !document.querySelector(".session-composer")?.hasAttribute("data-motion"))
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
  expect((await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!.y).toBeLessThan(480)
  await toggleAndPause()
  await page.getByRole("button", { name: "Toggle surface" }).click()
  expect(await page.locator(".session-composer").count()).toBe(0)
  await page.getByRole("button", { name: "Toggle surface" }).click()
  expect(await page.locator(".session-composer").getAttribute("data-motion")).toBeNull()
  expect(errors).toEqual([])
}, 15_000)
