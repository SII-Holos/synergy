import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject, writeMinimalPlugin, minimalPluginSource } from "../../packages/plugin-kit/test/fixtures"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { importPreviewConversation } from "./session-fixture"

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
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/product-runtime/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    const conversation = await importPreviewConversation(preview, { title: "History fixture", turns: 360 })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    diagnostics = await openPluginPreviewPage(preview, page)
    await page.goto(conversation.url)
    await page.getByText("Answer 360", { exact: true }).waitFor()
    const roots = page.locator('[data-message-role="user"]')
    expect(await roots.count()).toBe(20)
    await page.waitForFunction(() => {
      const scroller = document.querySelector('[data-message-role="user"]')?.closest(".overflow-y-auto")
      return scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 10
    })
    await roots.last().hover()
    await page.mouse.wheel(0, -1000)
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      const first = await roots.first().getAttribute("data-message-id")
      await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
      await page.waitForFunction(
        (id) => document.querySelector('[data-message-role="user"]')?.getAttribute("data-message-id") !== id,
        first,
      )
      expect(await roots.count()).toBeLessThanOrEqual(250)
    }
    await page.getByRole("button", { name: "Return to latest", exact: true }).click()
    await page.getByText("Answer 360", { exact: true }).waitFor()
    const { data } = await preview.client.session.messages(
      { scopeID: "home", sessionID: conversation.id },
      { throwOnError: true },
    )
    const latest = data?.find((item) => item.parts.some((part) => part.type === "text" && part.text === "Answer 360"))
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
    expect(await roots.count()).toBeLessThanOrEqual(250)
    await page.reload()
    await page.getByText("Answer 360 recovered after reconnect", { exact: true }).waitFor()
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
