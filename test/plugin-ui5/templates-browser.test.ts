import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject } from "../../packages/plugin-kit/test/fixtures"
import { PLUGIN_TEMPLATES, scaffoldPluginProject } from "../../packages/plugin-kit/src/commands/create"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { packPluginProject } from "../../packages/plugin-kit/src/commands/pack"
import { importPreviewConversation } from "./session-fixture"
const require = createRequire(path.resolve(import.meta.dir, "../../packages/app/package.json"))
const { chromium } = await import(require.resolve("playwright"))

test("all eight packed templates register and their contributed presentations mount in the production host", async () => {
  const projects = PLUGIN_TEMPLATES.map((template) => ({ template, project: createFixtureProject(`host-${template}`) }))
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
  try {
    const artifacts: string[] = []
    for (const { template, project } of projects) {
      scaffoldPluginProject(`sample-${template}`, template, project.root)
      expect(await buildPluginProject(project.root)).toBe(true)
      const archive = packPluginProject(project.root)
      const installed = path.join(project.root, "installed")
      await mkdir(installed)
      expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", installed]).exitCode).toBe(0)
      artifacts.push(installed)
    }
    preview = await startPluginPreview({
      artifacts,
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/synergy/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    const tools = await preview.client.tool.ids({ scopeID: "home" }, { throwOnError: true })
    expect(tools.data).toContain("plugin__sample-api-connector__get-json")
    expect(tools.data).toContain("plugin__sample-tool-ui__greet")
    const conversation = await importPreviewConversation(preview, {
      title: "Template acceptance",
      tool: "plugin__sample-tool-ui__greet",
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(15000)
    diagnostics = await openPluginPreviewPage(preview, page)
    await page.goto(conversation.url)
    await page.locator('[data-plugin-ui="sample-slot"]').waitFor()
    await page.locator('[data-plugin-ui="sample-tool-ui"]').waitFor()
    await page.getByRole("button", { name: /open side workspace/i }).click()
    await page.getByRole("button", { name: /sample-workbench-panel/ }).click()
    await page.locator('[data-plugin-ui="sample-workbench-panel"]').waitFor()
    await page.goto(new URL("/plugins/sample-navigation/main", preview.url).href)
    await page.locator('[data-plugin-ui="sample-navigation"]').waitFor()
    const themeContributions = await preview.client.plugin.listGlobalThemeContributions(undefined, {
      throwOnError: true,
    })
    expect(JSON.stringify(themeContributions.data)).toContain("sample-theme-icon")
    await page.evaluate((server) => {
      localStorage.setItem(
        "synergy.global.dat:plugin-shells",
        JSON.stringify({ version: 1, servers: { [server]: "sample-shell:main" } }),
      )
      localStorage.setItem(
        "synergy.global.dat:plugin-skins",
        JSON.stringify({ version: 1, servers: { [server]: "sample-skin:paper" } }),
      )
    }, new URL(preview.url).origin)
    await page.goto(conversation.url)
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    await page.locator('[data-skin-root="sample-skin:paper"]').first().waitFor({ state: "attached" })
    expect(
      await page.locator('[data-ui-part="composer"]').evaluate((node) => getComputedStyle(node).borderRadius),
    ).toBe("16px")
    expect(diagnostics.errors.map((error) => error.message)).toEqual([])
  } catch (error) {
    throw new AggregateError([error, ...(diagnostics?.errors ?? [])], "Packed template acceptance failed")
  } finally {
    diagnostics?.dispose()
    await browser.close()
    await preview?.close()
    for (const { project } of projects) project.cleanup()
  }
}, 120000)
