import { expect, test } from "bun:test"
import path from "node:path"
import { createRequire } from "node:module"
import { startPluginPreview, approvePreviewPlugins, openPluginPreviewPage } from "../../packages/plugin-kit/src/testing"
import { createFixtureProject } from "../../packages/plugin-kit/test/fixtures"
import { scaffoldPluginProject } from "../../packages/plugin-kit/src/commands/create"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"
import { packPluginProject } from "../../packages/plugin-kit/src/commands/pack"
import { mkdir } from "node:fs/promises"
const require = createRequire(path.resolve(import.meta.dir, "../../apps/web/package.json"))
const { chromium } = await import(require.resolve("playwright"))

test("packed Shell mounts through the production App and host approval path", async () => {
  const project = createFixtureProject("shell-host")
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  try {
    scaffoldPluginProject("acceptance-shell", "shell", project.root)
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
    const page = await browser.newPage()
    await page.addInitScript(
      ({ server, shell }) =>
        localStorage.setItem(
          "synergy.global.dat:plugin-shells",
          JSON.stringify({ version: 1, servers: { [server]: shell } }),
        ),
      { server: new URL(preview.url).origin, shell: "acceptance-shell:main" },
    )
    const fixture = await openPluginPreviewPage(preview, page)
    await page
      .getByText("Studio", { exact: true })
      .waitFor({ timeout: 20000 })
      .catch(async (error) => {
        throw new AggregateError(
          [error, ...fixture.errors, new Error(await page.locator("body").innerText())],
          "Shell did not mount",
        )
      })
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 20000 })
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draft retained across workbench changes")
    await page.getByRole("button", { name: "Plugins", exact: true }).click()
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ state: "detached" })
    expect(await page.getByText("Studio", { exact: true }).count()).toBe(1)
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe(
      "Draft retained across workbench changes",
    )
    await page.goto(new URL("/?safe-ui=1", preview.url).href)
    await page.locator("[data-component=prompt-input]").waitFor({ timeout: 20000 })
    expect(await page.locator("[data-component=prompt-input]").innerText()).toBe(
      "Draft retained across workbench changes",
    )
    await page.locator("[data-component=prompt-input]").fill("Edited by the native composer")
    expect(
      await page.evaluate(() =>
        Object.values(localStorage).some((value) => value.includes("Edited by the native composer")),
      ),
    ).toBe(true)
    await page.reload()
    await page.locator("[data-component=prompt-input]").filter({ hasText: "Edited by the native composer" }).waitFor()
    expect(await page.getByText("Studio", { exact: true }).count()).toBe(0)
    expect(fixture.errors.map((error) => error.message)).toEqual([])
    fixture.dispose()
  } finally {
    await browser.close()
    await preview?.close()
    project.cleanup()
  }
}, 90000)

test("functional plugin commands, events, settings and resource close guards work inside a custom Shell", async () => {
  const shell = createFixtureProject("combined-shell")
  const functional = createFixtureProject("combined-functional")
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  const browser = await chromium.launch({ headless: true })
  let diagnostics: { errors: Error[]; dispose(): unknown } | undefined
  let stage = "build artifacts"
  const watchdog = setTimeout(() => console.error(`Functional acceptance stalled at: ${stage}`), 75000)
  try {
    const { cp } = await import("node:fs/promises")
    await cp(path.resolve(import.meta.dir, "../../packages/plugin-kit/test/fixtures/ui5-functional"), functional.root, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("dist") && !source.split(path.sep).includes("generated"),
    })
    scaffoldPluginProject("acceptance-shell", "shell", shell.root)
    const installed: string[] = []
    for (const project of [shell, functional]) {
      expect(await buildPluginProject(project.root)).toBe(true)
      const archive = packPluginProject(project.root)
      const target = path.join(project.root, "installed")
      await mkdir(target)
      expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", target]).exitCode).toBe(0)
      installed.push(target)
    }
    stage = "start isolated host"
    preview = await startPluginPreview({
      artifacts: installed,
      command: [
        process.execPath,
        path.resolve(import.meta.dir, "../../packages/product-runtime/src/index.ts"),
        "--print-logs",
        "--log-level",
        "DEBUG",
      ],
    })
    stage = "approve fixture plugins"
    await approvePreviewPlugins(preview)
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    await page.addInitScript(
      ({ server, shell }) =>
        localStorage.setItem(
          "synergy.global.dat:plugin-shells",
          JSON.stringify({ version: 1, servers: { [server]: shell } }),
        ),
      { server: new URL(preview.url).origin, shell: "acceptance-shell:main" },
    )
    stage = "load Shell and functional contributions"
    diagnostics = await openPluginPreviewPage(preview, page)
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    stage = "command and event update"
    await page.getByRole("button", { name: "Increment example counter", exact: true }).click()
    await page.getByLabel("Example counter").filter({ hasText: "1" }).waitFor()
    stage = "settings and nested overlay"
    await page.getByRole("button", { name: "Example settings", exact: true }).click()
    await page.getByRole("dialog", { name: "Example settings", exact: true }).waitFor()
    await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Ada")
    await page.getByRole("button", { name: "Options", exact: true }).click()
    await page.getByRole("button", { name: "Style: Quick", exact: true }).click()
    await page.getByRole("option", { name: "Detailed", exact: true }).click()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Save preferences", exact: true }).click()
    await page.getByRole("dialog", { name: "Example settings", exact: true }).waitFor({ state: "detached" })
    stage = "resource dirty close guard"
    await page.getByRole("button", { name: "Example note", exact: true }).click()
    await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Unsaved note")
    await page.getByRole("button", { name: "Close note", exact: true }).click()
    await page.getByRole("dialog", { name: "Discard note changes?", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    expect(await page.getByRole("textbox", { name: "Note text", exact: true }).inputValue()).toBe("Unsaved note")
    await page.getByRole("button", { name: "Save note", exact: true }).click()
    stage = "second resource identity"
    await page.getByRole("button", { name: "Second note", exact: true }).click()
    expect(await page.getByRole("textbox", { name: "Note title", exact: true }).inputValue()).toBe("Second note")
    await page.getByRole("button", { name: "Close note", exact: true }).click()
    expect(diagnostics.errors.map((error) => error.message)).toEqual([])
  } catch (error) {
    if (preview) {
      const log = await Bun.file(path.join(preview.home, "host.log")).text()
      console.error(log.slice(-16000).replaceAll(preview.home, "<preview>").replaceAll(process.cwd(), "<checkout>"))
    }
    throw new AggregateError(
      [error, ...(diagnostics?.errors ?? [])],
      `Real-host functional acceptance failed at: ${stage}`,
    )
  } finally {
    stage = "dispose browser and isolated host"
    diagnostics?.dispose()
    await browser.close()
    await preview?.close()
    shell.cleanup()
    functional.cleanup()
    clearTimeout(watchdog)
  }
}, 90000)
