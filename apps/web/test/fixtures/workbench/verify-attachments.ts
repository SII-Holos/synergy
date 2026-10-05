import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: verify-attachments.ts <isolated-home> <production-server-origin>")
const url = new URL(origin)
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !url.port)
  throw new Error("Acceptance requires an explicit loopback HTTP port")
const selectedHome = await realpath(home)
assert.notEqual(selectedHome, await realpath(homedir()), "Acceptance requires an isolated home")
const client = createSynergyClient({ baseUrl: url.origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
assert.equal(await realpath(paths.home), selectedHome)
const output = path.join(home, "attachment-acceptance", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output } })
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const responses: Array<{ at: number; path: string; status: number }> = []
page.on("response", (response) => {
  const address = new URL(response.url())
  if (address.origin === url.origin && !address.pathname.startsWith("/assets/"))
    responses.push({ at: Date.now(), path: address.pathname, status: response.status() })
})
const checks: string[] = []
const check = (value: unknown, name: string) => {
  assert.ok(value, name)
  checks.push(name)
}
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const applyColorScheme = async (colorScheme: "light" | "dark") => {
  await page.emulateMedia({ colorScheme })
  await page.waitForFunction((mode) => document.documentElement.dataset.colorScheme === mode, colorScheme)
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition)))
}
type Frame = {
  cards: number
  messages: number
  times: number
  preparing: boolean
  order: string[]
  at: number
  rows: string[]
}
let releaseCreate: () => void = () => {}
const creation = new Promise<void>((resolve) => {
  releaseCreate = resolve
})
let capturedCreate = false
try {
  await page.goto(`${url.origin}/aG9tZQ/session`)
  await editor.waitFor()
  const files: string[] = []
  for (const [name, width, height] of [
    ["portrait", 640, 1280],
    ["landscape", 1200, 800],
  ] as const) {
    const encoded = await page.evaluate(
      ([width, height]) => {
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const paint = canvas.getContext("2d")!
        paint.fillStyle = "#e2ebee"
        paint.fillRect(0, 0, width, height)
        paint.fillStyle = "#334f59"
        for (let y = 0; y < height; y += 80) paint.fillRect(0, y, width, 2)
        for (let x = 0; x < width; x += 80) paint.fillRect(x, 0, 2, height)
        paint.font = "48px sans-serif"
        paint.fillText(`${width} × ${height}`, 40, 80)
        return canvas.toDataURL("image/png").split(",")[1]
      },
      [width, height],
    )
    const file = path.join(output, `${name}.png`)
    await Bun.write(file, Buffer.from(encoded, "base64"))
    files.push(file)
  }
  const documentFile = path.join(output, "A long attachment document name.txt")
  await Bun.write(documentFile, "Synthetic attachment reader acceptance.\n")
  files.push(documentFile)
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: /^(添加|Add)$/ }).click()
  await page.getByText(/^(添加文件|Add files)$/).click()
  await (await chooser).setFiles(files)
  const draftImages = page.locator('.prompt-attachments [data-component="attachment-card"][data-type="image"]')
  await draftImages.first().waitFor()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.prompt-attachments [data-component="attachment-card"][data-type="image"]').length ===
      2,
  )
  await page.locator('.prompt-attachments button[data-component="attachment-card"][data-type="image"]').nth(1).waitFor()
  for (const image of await draftImages.all()) {
    const box = await image.boundingBox()
    check(
      box && Math.abs(box.width - 96) < 1 && Math.abs(box.height - 72) < 1,
      `draft image is 96 × 72 after upload: ${JSON.stringify(box)}`,
    )
  }
  check(
    (await page.locator(".composer-resize-handle").getAttribute("aria-valuemin")) === "48",
    "attachments use the shared 48-pixel editor minimum",
  )
  for (const colorScheme of ["light", "dark"] as const) {
    await applyColorScheme(colorScheme)
    await page.screenshot({ path: path.join(output, `draft-${colorScheme}.png`) })
  }
  await applyColorScheme("light")
  await page.route("**/session", async (route) => {
    if (route.request().method() !== "POST" || capturedCreate) return route.continue()
    capturedCreate = true
    await creation
    await route.continue()
  })
  await editor.fill("[short] Inspect both images and the attached document.")
  await page.evaluate(() => {
    const frames: Frame[] = []
    let recording = true
    Object.assign(window, {
      attachmentAcceptance: {
        frames,
        stop: () => {
          recording = false
        },
      },
    })
    const sample = () => {
      if (!recording) return
      const messages = Array.from(document.querySelectorAll('[data-component="user-message"]')).filter(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest("[inert]") &&
          getComputedStyle(element).visibility !== "hidden",
      )
      const user = messages[0]
      if (user || frames.length)
        frames.push({
          at: Date.now(),
          rows: Array.from(document.querySelectorAll("[data-display-row]")).map(
            (element) => element.getAttribute("data-display-row") ?? "",
          ),
          cards: user?.querySelectorAll('[data-component="attachment-card"]').length ?? 0,
          messages: messages.length,
          times: user?.querySelectorAll('[data-slot="user-message-time"]').length ?? 0,
          preparing: !!document.querySelector('[data-slot="turn-process-trigger"] [role="status"]'),
          order: Array.from(user?.querySelectorAll('[data-component="attachment-card"]') ?? []).map(
            (element) => element.getAttribute("title") ?? "",
          ),
        })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.locator(".prompt-input-submit").click()
  const preparing = page.locator('.session-conversation-content [data-component="user-message"]')
  await preparing.locator('[data-component="attachment-card"]').nth(2).waitFor()
  check(capturedCreate, "session creation is delayed while the shared attachment view is visible")
  check((await preparing.locator('[data-slot="user-message-time"]').count()) === 1, "preparation has one timestamp")
  await editor.fill("Next draft survives attachment submission")
  await preparing.getByRole("button", { name: /Open portrait.png|打开 portrait.png/, exact: true }).click()
  await page.locator(".attachment-image-stage img").waitFor()
  checks.push("preparation opens the shared temporary reader")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await page.screenshot({ path: path.join(output, "preparing.png") })
  releaseCreate()
  await page.waitForURL(/\/session\/[^/]+$/)
  const sent = page.locator('.session-conversation-content [data-component="user-message"]')
  await sent.locator('[data-component="attachment-card"]').nth(2).waitFor()
  await page
    .getByText(/已收到测试任务/)
    .first()
    .waitFor({ timeout: 30000 })
  check(
    (await editor.innerText()) === "Next draft survives attachment submission",
    "later typing survives the canonical handoff",
  )

  await Bun.write(
    path.join(output, "message-dom.json"),
    JSON.stringify(
      await sent.evaluateAll((elements) =>
        elements.map((element) => ({
          visibility: getComputedStyle(element).visibility,
          inert: !!element.closest("[inert]"),
          bounds: element.getBoundingClientRect().toJSON(),
          row: element.closest("[data-display-row]")?.getAttribute("data-display-row"),
          type: element.getAttribute("data-variant"),
          cards: element.querySelectorAll('[data-component="attachment-card"]').length,
          meta: element.querySelectorAll('[data-slot="user-message-time"]').length,
        })),
      ),
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(output, "frames.json"),
    JSON.stringify(
      await page.evaluate(
        () => (window as unknown as { attachmentAcceptance: { frames: Frame[] } }).attachmentAcceptance.frames,
      ),
      null,
      2,
    ),
  )
  check((await sent.count()) === 1, "canonical transcript has one user message")
  check(
    (await sent.locator('[data-slot="user-message-time"]').count()) === 1,
    "canonical attachments share one timestamp",
  )
  check(
    (await sent.locator('[data-slot="user-message-copy"]').count()) === 1,
    "canonical content shares one copy operation",
  )
  const frames = await page.evaluate(() => {
    const fixture = (window as unknown as { attachmentAcceptance: { frames: Frame[]; stop(): void } })
      .attachmentAcceptance
    fixture.stop()
    return fixture.frames
  })
  check(frames.length > 2 && frames[0].cards === 3, "the first submission frame contains rendered attachments")
  await Bun.write(path.join(output, "frames.json"), JSON.stringify(frames, null, 2))
  await Bun.write(path.join(output, "responses.json"), JSON.stringify(responses, null, 2))
  check(
    frames.every((frame) => frame.order.join("|") === "portrait.png|landscape.png|A long attachment document name.txt"),
    "attachment order survives upload completion and canonical admission",
  )
  check(
    frames.every((frame) => frame.cards === 3 && frame.messages === 1 && frame.times === 1),
    `every handoff frame retains one complete attachment message: ${JSON.stringify(frames.filter((frame) => frame.cards !== 3 || frame.messages !== 1 || frame.times !== 1))}`,
  )
  for (const colorScheme of ["light", "dark"] as const) {
    await applyColorScheme(colorScheme)
    await page.screenshot({ path: path.join(output, `sent-${colorScheme}.png`) })
  }
  const attachment = sent.getByRole("button", { name: /Open portrait.png|打开 portrait.png/, exact: true })
  await attachment.click()
  await page.locator(".attachment-workbench .attachment-image-stage img").waitFor()
  for (const key of ["Enter", "Space"]) {
    await attachment.focus()
    await attachment.press(key)
  }
  check(
    (await page.getByRole("tab", { name: "portrait.png", exact: true }).count()) === 1,
    "repeated keyboard and pointer opening reuse the canonical resource tab",
  )
  await page.getByRole("button", { name: /^(放大|Zoom in)$/ }).click()
  check(
    (await page.locator(".attachment-image-preview").textContent())?.includes("125%"),
    "canonical image supports zoom",
  )
  await page.getByRole("button", { name: /^(全屏|Full screen)$/ }).click()
  await page.getByRole("button", { name: /退出全屏|Exit full screen/ }).waitFor()
  check(
    (await page.getByRole("link", { name: /^(下载|Download)$/ }).getAttribute("download")) === "portrait.png",
    "fullscreen preserves original download",
  )
  await page.screenshot({ path: path.join(output, "reader-fullscreen.png") })
  await page.getByRole("button", { name: /退出全屏|Exit full screen/ }).click()
  await page.getByRole("button", { name: /Close portrait.png|关闭 portrait.png/, exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.includes("portrait.png"))
  checks.push("closing the canonical reader restores attachment focus")
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `no horizontal overflow at ${width}px`,
    )
    await page.screenshot({ path: path.join(output, `sent-${width}.png`) })
  }
  await page.setViewportSize({ width: 720, height: 450 })
  const zoom = await context.newCDPSession(page)
  await zoom.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 450,
    deviceScaleFactor: 2,
    mobile: false,
  })
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "attachments remain contained at 200 percent interface zoom",
  )
  await attachment.focus()
  await attachment.press("Enter")
  await page.locator(".attachment-image-stage img").waitFor()
  await page.screenshot({ path: path.join(output, "reader-200-percent.png") })
  check(errors.length === 0, `no page errors: ${errors.join("; ")}`)
  await Bun.write(path.join(output, "result.json"), JSON.stringify({ checks, passed: true }, null, 2))
  console.log(`Passed ${checks.length} production attachment checks; evidence: ${output}`)
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") })
  await Bun.write(
    path.join(output, "failure.txt"),
    `${error}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`,
  )
  throw error
} finally {
  releaseCreate()
  await context.close()
  await browser.close()
}
