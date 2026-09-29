import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium, type Locator } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: verify.ts <isolated-home> <production-server-origin>")
const url = new URL(origin)
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !url.port)
  throw new Error("Acceptance requires an explicit loopback HTTP port")
const selectedHome = await realpath(home)
if (selectedHome === (await realpath(homedir()))) throw new Error("Acceptance requires an isolated home")
const client = createSynergyClient({ baseUrl: url.origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
assert.equal(await realpath(paths.home), selectedHome)
const manifest = (await Bun.file(path.join(home, "workbench-fixtures.json")).json()) as {
  scopes: string[]
  sessions: { id: string; scopeID: string }[]
}
const output = path.join(home, "acceptance-completion", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output } })
const page = await context.newPage()
const failures: string[] = []
page.on("pageerror", (error) => failures.push(error.message))
const route = (scope: string, session = "") =>
  `${url.origin}/${Buffer.from(scope).toString("base64url")}/session${session ? `/${session}` : ""}`
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const checks: string[] = []
const check = (value: unknown, name: string) => {
  assert.ok(value, name)
  checks.push(name)
}
async function open(scope = "home", session = "") {
  await page.goto(route(scope, session))
  await editor.waitFor()
  await page.locator(".session-work-context").waitFor()
}
async function geometry(trigger: Locator, name: string) {
  const before = await trigger.boundingBox()
  assert.ok(before)
  const iconBefore = await trigger.locator('[data-component="icon"]').first().boundingBox()
  await trigger.hover()
  await page.waitForTimeout(450)
  const hovered = await trigger.boundingBox()
  assert.ok(hovered)
  check(Math.abs(before.x - hovered.x) <= 1 && Math.abs(before.width - hovered.width) <= 1, `${name}: hover geometry`)
  await trigger.click()
  const popup = page.locator('[data-component="popover-content"]').last()
  await popup.waitFor()
  await page.waitForTimeout(210)
  const box = await popup.boundingBox()
  assert.ok(box)
  const size = page.viewportSize()!
  check(
    box.x >= -1 && box.y >= -1 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1,
    `${name}: popup within viewport`,
  )
  const opened = await trigger.boundingBox()
  const iconOpened = await trigger.locator('[data-component="icon"]').first().boundingBox()
  check(opened && Math.abs(before.x - opened.x) <= 1 && Math.abs(before.y - opened.y) <= 1, `${name}: open geometry`)
  if (iconBefore && iconOpened)
    check(
      Math.abs(iconBefore.x - iconOpened.x) <= 1 && Math.abs(iconBefore.y - iconOpened.y) <= 1,
      `${name}: icon geometry`,
    )
  await page.keyboard.press("Escape")
  await popup.waitFor({ state: "hidden" })
  check(await trigger.evaluate((el) => el === document.activeElement), `${name}: Escape focus`)
}
try {
  await open()
  check((await page.locator(".session-starter-card").count()) === 3, "three real task starters")
  check((await page.locator(".session-status-bar button").count()) >= 3, "new task has real status actions")
  await page
    .locator(".session-status-bar")
    .getByRole("button", { name: /详情|Details/ })
    .last()
    .click()
  await page.locator('[data-component="popover-content"]').waitFor()
  checks.push("real status details open")
  await page.keyboard.press("Escape")
  await page.locator('input[type="file"]').setInputFiles(path.join(home, "fixture.txt"))
  await page.getByText("fixture.txt", { exact: true }).first().waitFor()
  await editor.fill("Keep this draft")
  await page.locator(".session-starter-card").nth(0).click()
  await page.getByRole("button", { name: /^(取消|Cancel)$/ }).click()
  check((await editor.innerText()) === "Keep this draft", "cancel preserves text")
  await page.locator(".session-starter-card").nth(1).click()
  await page.getByRole("button", { name: /使用任务引导|Use task starter/ }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "textbox")
  check((await editor.innerText()).length > 20, "starter replaces text and focuses editor")
  check(await page.getByText("fixture.txt", { exact: true }).first().isVisible(), "starter preserves attachment")
  check(page.url() === route("home"), "starter does not send")
  await editor.fill("")
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(output, `${scheme}-home.png`) })
    for (const [name, trigger] of [
      ["Agent", page.locator('.prompt-input-toolbar-main button[aria-haspopup="dialog"]').first()],
      ["Permission", page.getByRole("button", { name: /权限模式|permission mode/i })],
      ["Add", page.getByRole("button", { name: /^(添加|Add)$/ })],
      ["Start", page.getByRole("button", { name: /^(启动模式|Start mode)$/ })],
      ["Thinking", page.getByRole("button", { name: /选择思考强度|Select thinking/ })],
    ] as const)
      await geometry(trigger, `${scheme}/${name}`)
    await page.getByRole("button", { name: /^(添加|Add)$/ }).click()
    await page.screenshot({ path: path.join(output, `${scheme}-menu.png`) })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /打开侧边工作区|Open side workspace/ }).click()
    await page.waitForTimeout(350)
    await page.screenshot({ path: path.join(output, `${scheme}-split.png`) })
    await geometry(page.getByRole("button", { name: /^(启动模式|Start mode)$/ }), `${scheme}/split Start`)
    await page.getByRole("button", { name: /隐藏侧边工作区|Hide side workspace/ }).click()
    await page.waitForTimeout(350)
  }
  for (const size of [
    { width: 800, height: 750 },
    { width: 375, height: 812 },
    { width: 1440, height: 480 },
  ]) {
    await page.setViewportSize(size)
    await page.screenshot({ path: path.join(output, `home-${size.width}x${size.height}.png`) })
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `no horizontal overflow ${size.width}`,
    )
    const send = await page.locator(".prompt-input-submit").boundingBox()
    check(send && send.y >= 0 && send.y + send.height <= size.height, `send accessible ${size.width}`)
    await geometry(page.getByRole("button", { name: /^(添加|Add)$/ }), `width ${size.width}/Add`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(manifest.scopes[1])
  check(
    !/^(Home|全局)$/.test(await page.locator(".session-work-context-button").first().innerText()),
    "project new task context",
  )
  check((await page.locator(".session-status-bar button").count()) >= 3, "project new task real status")
  await editor.fill("[short] Workbench completion acceptance")
  await page.locator(".prompt-input-submit").click()
  await page.waitForURL(/\/session\/[^/]+$/)
  await page.locator(".session-conversation-content").waitFor()
  check((await page.locator(".session-starter-card").count()) === 0, "first send replaces greeting")
  check((await page.locator(".session-status-bar button").count()) >= 3, "existing session real status")
  await page.screenshot({ path: path.join(output, "existing-session.png") })
  check(failures.length === 0, `no page errors: ${failures.join("; ")}`)
  await Bun.write(
    path.join(output, "result.json"),
    JSON.stringify({ origin: url.origin, checks, passed: true }, null, 2),
  )
  console.log(`Passed ${checks.length} composed-workbench checks; evidence: ${output}`)
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") })
  await Bun.write(
    path.join(output, "failure.txt"),
    `${error}\n${failures.join("\n")}\n${await page.locator("body").innerText()}`,
  )
  throw error
} finally {
  await context.close()
  await browser.close()
}
