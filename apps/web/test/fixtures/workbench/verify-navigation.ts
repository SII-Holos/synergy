import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: verify-navigation.ts <isolated-home> <production-origin>")
const url = new URL(origin)
assert.ok(url.hostname === "127.0.0.1" && url.protocol === "http:" && url.port)
const selectedHome = await realpath(home)
assert.notEqual(selectedHome, await realpath(homedir()))
const client = createSynergyClient({ baseUrl: url.origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
assert.equal(await realpath(paths.home), selectedHome)
const output = path.join(home, "acceptance-navigation", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const checks: string[] = []
function check(value: unknown, name: string) {
  assert.ok(value, name)
  checks.push(name)
}
async function expanded(value: boolean) {
  const toggle = page.locator("[data-sidebar-toggle]")
  if ((await toggle.getAttribute("aria-expanded")) !== String(value)) await toggle.click()
  await page.waitForFunction((open) => {
    const sidebar = document.querySelector(".sb-root")!
    return open
      ? Math.abs(sidebar.getBoundingClientRect().width - parseFloat((sidebar as HTMLElement).style.width)) < 0.01
      : sidebar.getBoundingClientRect().width === 0
  }, value)
}
async function menuDismiss(page: Page) {
  await page.keyboard.press("Escape")
  await page.locator('[data-component="popover-content"]').waitFor({ state: "hidden" })
}
try {
  await page.goto(`${url.origin}/aG9tZQ/session`)
  const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
  await editor.waitFor()
  await page.locator(".sb-integrated [data-sidebar-toggle]").waitFor()
  checks.push("actual registered built-in Shell mounts integrated navigation")
  await expanded(true)
  await editor.fill("Navigation acceptance draft")
  const editorNode = await editor.elementHandle()
  const scroll = page.locator(".sb-scroll")
  await scroll.evaluate((element) => (element.scrollTop = 160))
  const savedScroll = await scroll.evaluate((element) => element.scrollTop)
  const savedWidth = (await page.locator(".sb-root").boundingBox())!.width
  await expanded(false)
  check(
    await page
      .locator(".sb-panel")
      .evaluate((element) => element.hasAttribute("inert") && getComputedStyle(element).opacity === "0"),
    "collapsed navigation excludes all descendants from painting and interaction",
  )
  check(await editorNode!.evaluate((element) => element.isConnected), "collapsing does not remount the editor")
  check((await editor.innerText()) === "Navigation acceptance draft", "collapse preserves draft")
  const nav = page.locator("[data-sidebar-navigation]")
  check((await nav.getByRole("button").count()) === 3, "collapsed bar has toggle, search and new")
  await nav.getByRole("button", { name: /搜索会话|Search sessions/ }).click()
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  checks.push("collapsed search opens the real search dialog")
  await expanded(true)
  check((await page.locator(".sb-root").boundingBox())!.width === savedWidth, "expanded width survives collapse")
  check((await scroll.evaluate((element) => element.scrollTop)) === savedScroll, "collection scroll survives collapse")
  for (const sidebarOpen of [true, false]) {
    await expanded(sidebarOpen)
    const toggle = page.getByRole("button", { name: /打开侧边工作区|Open side workspace/ })
    const before = (await toggle.boundingBox())!
    await toggle.click()
    await page.waitForTimeout(350)
    const close = page.getByRole("button", { name: /隐藏侧边工作区|Hide side workspace/ })
    const after = (await close.boundingBox())!
    check(
      Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1,
      "side toggle stays at the window corner across opening",
    )
    check(after.x + after.width > 1440 - 60, "side toggle remains at the outer right edge")
    const side = page.locator(".workbench-surface--side")
    if (sidebarOpen) await side.getByRole("button", { name: /^笔记|^Notes/ }).click()
    const tabs = side.getByRole("tablist")
    const lastAction = await tabs.getByRole("button", { name: /添加侧边面板|Add side panel/ }).boundingBox()
    check(lastAction && lastAction.x + lastAction.width < after.x, "workspace tabs leave the corner control clear")
    await close.press("Space")
    await page.waitForTimeout(350)
    check(
      await toggle.evaluate((element) => document.activeElement === element),
      "side toggle retains focus after keyboard collapse",
    )
    check(await editorNode!.evaluate((element) => element.isConnected), "side toggle preserves the editor instance")
    await toggle.click()
    check(
      await side.getByRole("tab", { name: /^笔记|^Notes/ }).isVisible(),
      "reopening retains the selected workspace tab",
    )
    await close.click()
    await page.waitForTimeout(350)
  }
  await expanded(true)
  for (const route of [/^日程$|^Agenda$/, /^知识库$|^Library$/]) {
    await page.locator(".sb-globals").getByRole("button", { name: route }).click()
    await expanded(false)
    await page.screenshot({
      path: path.join(output, route.source.includes("日程") ? "agenda-collapsed.png" : "library-collapsed.png"),
    })
    check(await page.locator("[data-sidebar-toggle]").isVisible(), "navigation can reopen on a non-session route")
    await expanded(true)
  }
  await page
    .locator(".sb-actions")
    .getByRole("button", { name: /新建会话|New session/ })
    .click()
  await editor.waitFor()
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expanded(true)
    await page.screenshot({ path: path.join(output, `${scheme}-expanded.png`) })
    await expanded(false)
    await page.screenshot({ path: path.join(output, `${scheme}-collapsed.png`) })
    const thinking = page.getByRole("button", { name: /选择思考强度|Select thinking effort/ }).filter({ visible: true })
    check(
      (await thinking.innerText()) === (await thinking.locator(".settings-model-variant-label").innerText()),
      "thinking toolbar shows only its current value",
    )
    const typography = await page.locator(".session-work-context button > span").evaluateAll((labels) =>
      labels.map((label) => {
        const style = getComputedStyle(label)
        return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.color].join("|")
      }),
    )
    check(
      typography.length >= 2 && typography.length <= 3 && new Set(typography).size === 1,
      "working location labels share typography and emphasis",
    )
    const add = page.getByRole("button", { name: /^(添加|Add)$/ })
    check(
      (await page.locator(".prompt-input-toolbar-main button").first().getAttribute("aria-label")) ===
        (await add.getAttribute("aria-label")),
      "Add precedes the selectors",
    )
    await add.click()
    check(
      (await page.locator('.prompt-add-menu [data-slot="list-group"]').count()) >= 2,
      "file and workflow sections render in the real menu",
    )
    await page.screenshot({ path: path.join(output, `${scheme}-add-menu.png`) })
    await menuDismiss(page)
    await page.getByRole("button", { name: "Workbench Chat", exact: true }).click()
    const popup = page.locator(".model-selector-popover")
    await popup.waitFor()
    await page.waitForTimeout(210)
    const badges = await popup
      .locator("[data-component=tag]")
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().right))
    check(
      badges.length >= 2 && Math.max(...badges) - Math.min(...badges) <= 1,
      "model badges align independently of selection",
    )
    const selectedRow = popup.locator('[data-slot="list-item"]:has([data-slot="list-item-selected-icon"])')
    const selectedGeometry = await selectedRow.evaluate((row) => {
      const marker = row.querySelector('[data-slot="list-item-selected-icon"]')!.getBoundingClientRect()
      const label = row.querySelector(".model-manager-name")!.getBoundingClientRect()
      return {
        markerLeft: marker.left,
        markerRight: marker.right,
        labelRight: label.right,
        rowRight: row.getBoundingClientRect().right,
      }
    })
    check(
      selectedGeometry.markerLeft >= selectedGeometry.labelRight + 4 &&
        selectedGeometry.rowRight - selectedGeometry.markerRight <= 16,
      "model check owns a separate trailing column",
    )
    await page.waitForTimeout(210)
    const bounds = (await popup.boundingBox())!
    check(bounds.height < 330, "few models use natural menu height")
    await page.screenshot({ path: path.join(output, `${scheme}-model-menu.png`) })
    await popup
      .getByRole("button", { name: /^Workbench Auxiliary/ })
      .last()
      .click()
    await page.getByRole("button", { name: "Workbench Auxiliary", exact: true }).click()
    await popup.waitFor()
    await page.waitForTimeout(210)
    const switchedBadges = await popup
      .locator("[data-component=tag]")
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().right))
    check(
      switchedBadges.every((right) => Math.abs(right - badges[0]) <= 1),
      "changing the selected model does not move metadata badges",
    )
    check(
      (await popup.locator('[data-slot="list-item"]:has([data-slot="list-item-selected-icon"])').innerText()).includes(
        "Workbench Auxiliary",
      ),
      "the selection marker follows the chosen model",
    )
    await popup
      .getByRole("button", { name: /^Workbench Chat/ })
      .last()
      .click()
    await page.getByRole("button", { name: "Workbench Chat", exact: true }).click()
    await popup.getByRole("textbox").fill("no-model-matches-this-query")
    await page.waitForTimeout(200)
    check((await popup.boundingBox())!.height < bounds.height, "empty model search releases unused space")
    check(
      await popup.getByRole("button", { name: /模型设置|Model settings/ }).isVisible(),
      "model settings stay visible with no results",
    )
    await menuDismiss(page)
  }
  for (const size of [
    { width: 800, height: 750 },
    { width: 1440, height: 480 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(350)
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `no overflow ${size.width}x${size.height}`,
    )
    await page.screenshot({ path: path.join(output, `viewport-${size.width}x${size.height}.png`) })
    if (size.width >= 768) {
      check(await page.locator("[data-sidebar-toggle]").isVisible(), "desktop restore remains available")
      const toggle = page.getByRole("button", { name: /打开侧边工作区|Open side workspace/ })
      const before = (await toggle.boundingBox())!
      await toggle.click()
      await page.waitForTimeout(350)
      const close = page.getByRole("button", { name: /隐藏侧边工作区|Hide side workspace/ })
      const after = (await close.boundingBox())!
      check(
        Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1,
        `workspace control remains fixed at ${size.width}x${size.height}`,
      )
      await page.screenshot({ path: path.join(output, `viewport-${size.width}x${size.height}-split.png`) })
      await close.click()
    } else {
      await page.getByRole("button", { name: /打开导航|Open navigation/ }).click()
      await page.getByRole("dialog").waitFor()
      checks.push("375px retains the mobile navigation drawer")
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: /^(添加|Add)$/ }).click()
      check(
        (await page.locator('.prompt-add-menu [data-slot="list-group"]').count()) === 3,
        "mobile Add retains the agent group",
      )
      await menuDismiss(page)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expanded(true)
  check(
    (await page.locator(".sb-root").evaluate((el) => getComputedStyle(el).transitionDuration)) === "0s",
    "reduced motion removes sidebar travel",
  )
  const { data: providers } = await client.config.domain.get({ domain: "providers" }, { throwOnError: true })
  const { data: models } = await client.config.domain.get({ domain: "models" }, { throwOnError: true })
  assert.ok(providers.provider?.fixture, "Long-list acceptance requires the synthetic workbench provider")
  const samples = Array.from({ length: 48 }, (_, i) => ({
    id: `navigation-model-${i}`,
    name: `Navigation model ${i}: a deliberately long model name for truncation and search acceptance`,
  }))
  try {
    await client.config.domain.update(
      {
        domain: "providers",
        configDomainUpdateInput: {
          config: {
            provider: {
              fixture: {
                models: Object.fromEntries(
                  samples.map((sample) => [
                    sample.id,
                    {
                      name: sample.name,
                      tool_call: true,
                      limit: { context: 128000, output: 4096 },
                    },
                  ]),
                ),
              },
            },
          },
        },
      },
      { throwOnError: true },
    )
    await client.config.domain.update(
      {
        domain: "models",
        configDomainUpdateInput: {
          config: {
            quick_switcher: {
              models: samples.map((sample) => ({
                providerID: "fixture",
                modelID: sample.id,
                state: "add" as const,
              })),
            },
          },
        },
      },
      { throwOnError: true },
    )
    await page.reload()
    await page.getByRole("button", { name: "Workbench Chat", exact: true }).click()
    const popup = page.locator(".model-selector-popover")
    await popup.waitFor()
    const list = popup.locator('[data-slot="list-scroll"]')
    check(await list.evaluate((el) => el.scrollHeight > el.clientHeight), "many models scroll within the results area")
    const search = popup.getByRole("textbox")
    const searchBefore = (await search.boundingBox())!
    const footerBefore = (await popup.locator(".model-selector-footer").boundingBox())!
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight))
    check((await search.boundingBox())!.y === searchBefore.y, "search stays fixed while model results scroll")
    check(
      (await popup.locator(".model-selector-footer").boundingBox())!.y === footerBefore.y,
      "model footer stays fixed",
    )
    await page.screenshot({ path: path.join(output, "many-models.png") })
    await search.fill("navigation-model-47")
    await page.waitForTimeout(200)
    check((await popup.locator('[data-slot="list-item"]').count()) === 1, "model search filters the real long catalog")
    await popup.getByRole("button", { name: new RegExp(samples[47].name) }).click()
    await page.setViewportSize({ width: 800, height: 750 })
    await expanded(false)
    const selected = page.getByRole("button", { name: samples[47].name, exact: true })
    const label = selected.locator(".stb-selector-label")
    check(
      await label.evaluate((el) => el.scrollWidth > el.clientWidth),
      "long selected model truncates in a narrow topbar",
    )
    check((await selected.boundingBox())!.y < 48, "long model remains on the top row")
    await page.screenshot({ path: path.join(output, "long-model-narrow.png") })
  } finally {
    await client.config.domain.update(
      { domain: "providers", configDomainUpdateInput: { config: providers, mode: "replace-domain" } },
      { throwOnError: true },
    )
    await client.config.domain.update(
      { domain: "models", configDomainUpdateInput: { config: models, mode: "replace-domain" } },
      { throwOnError: true },
    )
  }
  await page.reload()
  await page.getByRole("button", { name: "Workbench Chat", exact: true }).waitFor()
  check(errors.length === 0, `no page errors: ${errors.join("; ")}`)
  await Bun.write(path.join(output, "result.json"), JSON.stringify({ passed: true, checks }, null, 2))
  console.log(`Passed ${checks.length} navigation checks; evidence: ${output}`)
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") })
  await Bun.write(
    path.join(output, "failure.txt"),
    `${error}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`,
  )
  throw error
} finally {
  await context.close()
  await browser.close()
}
