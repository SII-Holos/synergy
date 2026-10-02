import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject, writeMinimalPlugin, minimalPluginSource } from "../../packages/plugin-kit/test/fixtures"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { importPreviewConversation } from "./session-fixture"
import type { SessionTimelinePage } from "../../packages/sdk/js/src/client"

const require = createRequire(path.resolve(import.meta.dir, "../../apps/web/package.json"))
const { chromium } = await import(require.resolve("playwright"))

test("native public conversation retains bounded history and reconciles updates after reconnect", async () => {
  const project = createFixtureProject("message-host")
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
  try {
    writeMinimalPlugin(project, minimalPluginSource("message-fixture"), "message-fixture")
    expect(await buildPluginProject(project.root)).toBe(true)
    preview = await startPluginPreview({
      artifacts: [path.join(project.root, "dist")],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/presets/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    const conversation = await importPreviewConversation(preview, { title: "History fixture", turns: 360 })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    page.setDefaultTimeout(20000)
    diagnostics = await openPluginPreviewPage(preview, page)
    await page.route("**/session/**/timeline**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      await route.continue()
    })
    await page.goto(conversation.url)
    await page.getByText("Answer 360", { exact: true }).waitFor()
    const roots = page.locator('.session-conversation-content [data-display-row][data-message-role="user"]')
    expect(await roots.count()).toBeGreaterThan(0)
    expect(await roots.count()).toBeLessThanOrEqual(30)
    await page.waitForFunction(() => {
      const scroller = document.querySelector(".session-conversation-content")?.closest(".overflow-y-auto")
      return scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 10
    })
    await roots.last().hover()
    await page.mouse.wheel(0, -1000)
    let oldestTime = conversation.messages.at(-1)!.info.time.created
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      const [response] = await Promise.all([
        page.waitForResponse(async (response) => {
          const url = new URL(response.url())
          if (
            url.pathname !== `/session/${conversation.id}/timeline/page` ||
            !url.searchParams.has("cursor") ||
            url.searchParams.has("messageID") ||
            !response.ok()
          )
            return false
          const timeline = (await response.json()) as SessionTimelinePage
          const oldest = timeline.items.find((item) => item.info.role === "user")
          return !!oldest && oldest.info.time.created < oldestTime
        }),
        page.getByRole("button", { name: "Load earlier messages", exact: true }).click(),
      ])
      const text = await response.text()
      const timeline = JSON.parse(text) as SessionTimelinePage
      expect(response.ok()).toBe(true)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024)
      expect(timeline.items.length).toBeLessThanOrEqual(100)
      const oldest = timeline.items.find((item) => item.info.role === "user")!
      expect(oldest.info.time.created).toBeLessThan(oldestTime)
      oldestTime = oldest.info.time.created
      const original = conversation.messages.find((item) => item.info.id === oldest.info.id)!
      const question = original.parts.find((part) => part.type === "text")!
      if (question.type !== "text") throw new Error("Historical question text missing")
      await page.getByRole("button", { name: "Load earlier messages", exact: true }).waitFor()
      await page.evaluate(async () => {
        for (let frame = 0; frame < 3; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      const viewport = await page
        .locator(".session-conversation-content")
        .evaluate((node) => node.closest(".overflow-y-auto")!.getBoundingClientRect().toJSON())
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
      await page.mouse.wheel(0, -100_000)
      await page.getByText(question.text, { exact: true }).waitFor()
      expect(await roots.count()).toBeLessThanOrEqual(30)
      expect(await page.locator("[data-display-row]").count()).toBeLessThanOrEqual(80)
    }
    await page.keyboard.press("ControlOrMeta+f")
    const historySearch = page.getByRole("dialog", { name: "Search conversation", exact: true })
    await historySearch.waitFor()
    await historySearch.getByPlaceholder("Search all conversation history").fill("Question 137")
    expect(await historySearch.getByLabel("Include reasoning", { exact: true }).count()).toBe(1)
    expect(await historySearch.getByLabel("Include tool content", { exact: true }).count()).toBe(1)
    await historySearch.getByRole("button", { name: "Question 137", exact: true }).click()
    await historySearch.waitFor({ state: "detached" })
    await page.getByText("Question 137", { exact: true }).waitFor()
    expect(await roots.count()).toBeLessThanOrEqual(30)
    expect(await page.locator("[data-display-row]").count()).toBeLessThanOrEqual(80)
    const returnLatest = page.getByRole("button", { name: "Return to latest", exact: true })
    await returnLatest.click()
    await page.getByText("Answer 360", { exact: true }).waitFor()
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    const { data } = await preview.client.session.messages(
      { scopeID: "home", sessionID: conversation.id },
      { throwOnError: true },
    )
    const latest = data?.find((item) => item.parts.some((part) => part.type === "text" && part.text === "Answer 360"))
    expect(data).toHaveLength(720)
    const part = latest?.parts.find((part) => part.type === "text")
    if (!latest || !part) throw new Error("Conversation fixture part missing")
    await context.setOffline(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    await preview.client.part.update(
      {
        scopeID: "home",
        sessionID: conversation.id,
        messageID: latest.info.id,
        partID: part.id,
        part: { ...part, type: "text", text: "Answer 360 recovered after reconnect" },
      },
      { throwOnError: true },
    )
    await context.setOffline(false)
    await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
    expect(await roots.count()).toBeLessThanOrEqual(30)
    await page.reload()
    await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
    async function settings() {
      await page.locator(".sidebar-account-trigger").click()
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
      await dialog.waitFor()
      await dialog.getByRole("button", { name: "General", exact: true }).click()
      return dialog
    }
    let dialog = await settings()
    for (const choice of ["Full", "Balanced", "Minimal"])
      expect(await dialog.getByRole("button", { name: choice, exact: true }).count()).toBe(1)
    await dialog.getByRole("button", { name: "Minimal", exact: true }).click()
    expect(await dialog.getByRole("button", { name: "Minimal", exact: true }).getAttribute("aria-pressed")).toBe("true")
    const workspace = dialog.getByRole("group", { name: "New task starting point", exact: true })
    await workspace.getByRole("button", { name: "Worktree", exact: true }).click()
    expect(await workspace.getByRole("button", { name: "Worktree", exact: true }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    await dialog.getByRole("tab", { name: "Notifications", exact: true }).click()
    await dialog.getByText("In-app notification details", { exact: true }).click()
    const mute = dialog.getByLabel("Mute Info", { exact: true })
    const muted = await mute.isChecked()
    await dialog
      .locator('[data-component="switch"]')
      .filter({ has: page.getByLabel("Mute Info", { exact: true }) })
      .locator('[data-slot="switch-control"]')
      .click()
    expect(await mute.isChecked()).toBe(!muted)
    expect(await dialog.getByRole("slider", { name: "Interface zoom", exact: true }).count()).toBe(0)
    await dialog.getByRole("button", { name: "Save Changes", exact: true }).click()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.reload()
    await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
    dialog = await settings()
    expect(await dialog.getByRole("button", { name: "Minimal", exact: true }).getAttribute("aria-pressed")).toBe("true")
    expect(
      await dialog
        .getByRole("group", { name: "New task starting point", exact: true })
        .getByRole("button", { name: "Worktree", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true")
    await dialog.getByRole("tab", { name: "Notifications", exact: true }).click()
    await dialog.getByText("In-app notification details", { exact: true }).click()
    expect(await dialog.getByLabel("Mute Info", { exact: true }).isChecked()).toBe(!muted)
    expect(diagnostics.errors.map((error) => error.message)).toEqual([])
  } catch (error) {
    throw new AggregateError([error, ...(diagnostics?.errors ?? [])], "Conversation real-host acceptance failed")
  } finally {
    diagnostics?.dispose()
    await browser.close()
    await preview?.close()
    project.cleanup()
  }
}, 90000)
