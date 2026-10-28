import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { createSynergyClient, type Session } from "@ericsanchezok/synergy-sdk/client"

const [home, origin, sessionID] = process.argv.slice(2)
if (!home || !origin || !sessionID)
  throw new Error("Usage: verify-fork-composer.ts <isolated-home> <production-origin> <source-session-id>")
const url = new URL(origin)
assert.ok(url.hostname === "127.0.0.1" && url.protocol === "http:" && url.port)
const selectedHome = await realpath(home)
assert.notEqual(selectedHome, await realpath(homedir()))
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true } as const
assert.equal(await realpath((await client.path.get({ scopeID: "home" }, options)).data.home), selectedHome)
const source = (await client.session.get({ sessionID }, options)).data
assert.ok(!source.parentID && !source.forkedFrom, "Use an ordinary synthetic source session")
const history = (await client.session.messages({ sessionID }, options)).data
const replyIndex = history.findIndex((message) => message.info.role === "assistant")
assert.ok(replyIndex >= 1, "The source needs at least one completed exchange")
const sourcePath = `/${Buffer.from(source.scope.id).toString("base64url")}/session/${source.id}`
const output = path.join(home, "acceptance-fork-composer", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors: string[] = []
const created: Session[] = []
const checks: string[] = []
let passed = false

async function ready(page: Page) {
  await page
    .locator(".session-prompt-dock:visible")
    .getByRole("textbox", { name: /^(发送消息|Send message)$/ })
    .waitFor()
  await page.locator("[data-conversation-viewport]:visible").waitFor()
  await page.locator("[data-conversation-loading]:visible").waitFor({ state: "hidden" })
}

async function clean(page: Page, phase: string) {
  await ready(page)
  const dock = page.locator(".session-prompt-dock:visible")
  assert.equal(await dock.getByRole("button", { name: /^(后退|Back)$/ }).count(), 0, `${phase}: no generic Back`)
  assert.equal(await dock.getByText(/分叉自|Forked from/).count(), 0, `${phase}: no fork-source row`)
  checks.push(phase)
}

try {
  for (const entry of ["conversation", "reply"] as const) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      colorScheme: "light",
      locale: "zh-CN",
    })
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(`${url.origin}${sourcePath}`)
      await ready(page)
      if (entry === "conversation") await page.keyboard.press("ControlOrMeta+Shift+f")
      else
        await page
          .getByRole("button", { name: /^(从此消息分叉会话|Fork session from this message)$/ })
          .first()
          .click()
      const dialog = page.getByRole("dialog", { name: /^(分叉会话|Fork session)$/ })
      const response = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().includes(`/session/${source.id}/fork`),
      )
      await dialog.getByRole("button", { name: /^(分叉会话|Fork session)$/ }).click()
      const result = await response
      assert.equal(result.status(), 200)
      const fork = (await result.json()) as Session
      created.push(fork)
      await page.waitForURL(`**/session/${fork.id}`)
      await dialog.waitFor({ state: "hidden" })
      const saved = (await client.session.get({ sessionID: fork.id }, options)).data
      assert.equal(saved.forkedFrom?.sessionID, source.id)
      assert.equal(saved.workspaceID, source.workspaceID)
      assert.equal(
        (await client.session.messages({ sessionID: fork.id }, options)).data.length,
        entry === "conversation" ? history.length : replyIndex + 1,
      )
      await clean(page, `${entry} creation`)
      await page.reload()
      await clean(page, `${entry} reload`)
      await page.goBack()
      await page.waitForURL(`${url.origin}${sourcePath}`)
      await clean(page, `${entry} browser back`)
      await page.goForward()
      await page.waitForURL(`**/session/${fork.id}`)
      await clean(page, `${entry} browser forward`)
      await page.locator(".sb-root:visible").getByText(source.title, { exact: true }).first().click()
      await page.waitForURL(`${url.origin}${sourcePath}`)
      await clean(page, `${entry} sidebar source`)
      await page.locator(".sb-root:visible").getByText(saved.title, { exact: true }).first().click()
      await page.waitForURL(`**/session/${fork.id}`)
      await clean(page, `${entry} sidebar return`)
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: path.join(output, `${entry}-light.png`), animations: "disabled" })
      await page.setViewportSize({ width: 375, height: 812 })
      await clean(page, `${entry} narrow`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(output, `${entry}-narrow.png`), animations: "disabled" })
      const dark = await browser.newPage({
        viewport: { width: 1440, height: 960 },
        colorScheme: "dark",
        locale: "zh-CN",
      })
      dark.on("pageerror", (error) => errors.push(error.message))
      await dark.goto(page.url())
      await clean(dark, `${entry} dark direct entry`)
      await dark.evaluate(() => document.fonts.ready)
      await dark.screenshot({ path: path.join(output, `${entry}-dark.png`), animations: "disabled" })
      await dark.close()
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${entry}-failure.png`) })
      throw error
    } finally {
      await page.close()
    }
  }
  const unchanged = (await client.session.get({ sessionID }, options)).data
  assert.equal(unchanged.title, source.title)
  assert.equal(unchanged.workspaceID, source.workspaceID)
  assert.deepEqual(
    (await client.session.messages({ sessionID }, options)).data.map((message) => message.info.id),
    history.map((message) => message.info.id),
  )
  assert.deepEqual(errors, [])
  passed = true
  console.log(`Passed ${checks.length} fork-composer checks; evidence: ${output}`)
} finally {
  await Bun.write(path.join(output, "result.json"), JSON.stringify({ passed, checks, created, errors }, null, 2))
  await browser.close()
}
