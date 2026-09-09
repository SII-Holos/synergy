import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { cp, mkdir } from "node:fs/promises"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject } from "../../packages/plugin-kit/test/fixtures"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { packPluginProject } from "../../packages/plugin-kit/src/commands/pack"
const require = createRequire(path.resolve(import.meta.dir, "../../apps/web/package.json"))
const { chromium } = await import(require.resolve("playwright"))

test("two packed Skins apply packaged fonts, textures, decoration, modes and narrow recovery in the real host", async () => {
  const project = createFixtureProject("skin-host")
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  try {
    await cp(path.resolve(import.meta.dir, "../../packages/plugin-kit/test/fixtures/ui5-workbench"), project.root, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("dist") && !source.split(path.sep).includes("generated"),
    })
    expect(await buildPluginProject(project.root)).toBe(true)
    const archive = packPluginProject(project.root)
    const installed = path.join(project.root, "installed")
    await mkdir(installed)
    expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", installed]).exitCode).toBe(0)
    preview = await startPluginPreview({
      artifacts: [installed],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/product-runtime/src/index.ts")],
    })
    await approvePreviewPlugins(preview)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" })
    page.setDefaultTimeout(15000)
    await page.addInitScript((server) => {
      if (!localStorage.getItem("synergy.global.dat:plugin-skins"))
        localStorage.setItem(
          "synergy.global.dat:plugin-skins",
          JSON.stringify({ version: 1, servers: { [server]: "ui5-workbench:paper" } }),
        )
      localStorage.setItem(
        "synergy.global.dat:plugin-shells",
        JSON.stringify({ version: 1, servers: { [server]: "ui5-workbench:main" } }),
      )
    }, new URL(preview.url).origin)
    const fixture = await openPluginPreviewPage(preview, page)
    const composer = page.locator('[data-ui-part="composer"]')
    await page.locator('[data-skin-root="ui5-workbench:paper"]').first().waitFor({ state: "attached" })
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    expect(await composer.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("24px")
    const workbench = page.locator('[data-ui-part="workbench"]')
    expect(await workbench.evaluate((node) => getComputedStyle(node, "::before").backgroundImage)).toContain(
      "/plugin/assets/ui5-workbench/",
    )
    const family = await page.getByText("Studio", { exact: true }).evaluate(async (node) => {
      const family = getComputedStyle(node).fontFamily
      await document.fonts.load(`16px ${family}`)
      return family
    })
    expect(family).toContain("synergy-skin-")
    await page.emulateMedia({ colorScheme: "dark" })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-ui-part="workbench"]')!, "::before").opacity === "0.22",
    )
    await page.evaluate(
      (server) =>
        localStorage.setItem(
          "synergy.global.dat:plugin-skins",
          JSON.stringify({ version: 1, servers: { [server]: "ui5-workbench:observatory" } }),
        ),
      new URL(preview.url).origin,
    )
    await page.reload()
    await page.locator('[data-skin-root="ui5-workbench:observatory"]').first().waitFor({ state: "attached" })
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    expect(await composer.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("2px")
    expect(await workbench.evaluate((node) => getComputedStyle(node, "::after").content)).toBe('""')
    expect(await workbench.evaluate((node) => getComputedStyle(node, "::after").pointerEvents)).toBe("none")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-ui-part="workbench"]')!, "::after").content === "none",
    )
    await page.setViewportSize({ width: 375, height: 812 })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-ui-part="composer"]')!).borderRadius === "0px",
    )
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Narrow draft")
    await page.goto(new URL("/?safe-ui=1", preview.url).href)
    await page.locator('[data-component="prompt-input"]').waitFor()
    expect(await page.locator('[data-skin-root="ui5-workbench:observatory"]').count()).toBe(0)
    expect(fixture.errors.map((error) => error.message)).toEqual([])
    fixture.dispose()
  } finally {
    await browser.close()
    await preview?.close()
    project.cleanup()
  }
}, 90000)
