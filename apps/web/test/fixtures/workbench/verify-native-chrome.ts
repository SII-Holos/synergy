import assert from "node:assert/strict"
import { mkdir, realpath, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { prepareIsolatedDesktop } from "../../../../desktop/test/fixture/isolated-desktop"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: verify-native-chrome.ts <isolated-home> <production-origin>")
if (process.platform !== "darwin") throw new Error("Native titlebar acceptance requires macOS")
const options = await prepareIsolatedDesktop(home, origin)
const previous = await readFile(path.join(options.directory, "process.json"), "utf8").catch(() => undefined)
if (previous) {
  const { pid, running } = JSON.parse(previous) as { pid: number; running: boolean }
  if (running) {
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {}
    assert.equal(alive, false, "Close only the selected isolated Desktop before starting native acceptance")
  }
}
const client = createSynergyClient({ baseUrl: origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
assert.equal(await realpath(paths.home), options.home)
const root = process.cwd()
const requireWeb = createRequire(path.join(root, "apps/web/package.json"))
const { _electron: electron } = requireWeb("playwright") as typeof import("playwright")
const requireDesktop = createRequire(path.join(root, "apps/desktop/package.json"))
const executablePath: string = requireDesktop("electron")
const output = path.join(home, "acceptance-native-navigation", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
if (typeof Bun !== "undefined") {
  // Electron's Node-inspector connection requires Node; Chromium-only acceptance can run directly in Bun.
  const runner = path.join(options.directory, "verify-native.mjs")
  const build = await Bun.build({
    entrypoints: [import.meta.path],
    target: "node",
    external: ["electron"],
    format: "esm",
  })
  if (!build.success) throw new AggregateError(build.logs, "Could not build native acceptance runner")
  await Bun.write(runner, build.outputs[0])
  const child = Bun.spawn(["node", runner, home, origin], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exit(await child.exited)
}
const app = await electron.launch({
  executablePath,
  args: [options.wrapper],
  env: {
    ...process.env,
    SYNERGY_HOME: options.home,
    SYNERGY_DESKTOP_CHANNEL: "dev",
    SYNERGY_DESKTOP_SERVER_MODE: "external",
    SYNERGY_DESKTOP_APP_URL: options.appURL,
    SYNERGY_ACCEPTANCE_ENTRY: path.join(root, "apps/desktop/dist/main.js"),
  },
  recordVideo: { dir: output },
  timeout: 30000,
})
const checks: string[] = []
const measurements: unknown[] = []
const deadline = Date.now() + 30000
let page = app.windows().find((candidate) => candidate.url().startsWith(new URL(origin).origin))
while (!page && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  page = app.windows().find((candidate) => candidate.url().startsWith(new URL(origin).origin))
}
if (!page) {
  await app.close()
  throw new Error("The production Desktop surface did not open")
}
const check = (value: unknown, name: string) => {
  assert.ok(value, name)
  checks.push(name)
}
try {
  await page.waitForURL(`${new URL(origin).origin}/**`)
  await page.locator("[data-sidebar-toggle]").waitFor()
  await page.locator(".stb-root").waitFor()
  const window = await app.browserWindow(page)
  await window.evaluate((win) => {
    win.setFullScreen(false)
    win.setBounds({ x: 60, y: 60, width: 1440, height: 900 })
    win.show()
    win.focus()
  })
  const geometry = () =>
    page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Missing native acceptance element: ${selector}`)
        const b = element.getBoundingClientRect()
        return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right }
      }
      const overlay = (
        navigator as Navigator & { windowControlsOverlay: { getTitlebarAreaRect: () => DOMRect; visible: boolean } }
      ).windowControlsOverlay
      return {
        native: rect(".desktop-native-titlebar"),
        toggle: rect("[data-sidebar-toggle]"),
        sidebar: rect(".sb-root"),
        header: rect(".stb-root"),
        overlay: { x: overlay.getTitlebarAreaRect().x, visible: overlay.visible },
        viewport: innerWidth,
      }
    })
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const fullscreen of [false, true]) {
      await window.evaluate(
        (win, value) =>
          new Promise<void>((resolve) => {
            if (win.isFullScreen() === value) return resolve()
            win.once(value ? "enter-full-screen" : "leave-full-screen", () => resolve())
            win.setFullScreen(value)
          }),
        fullscreen,
      )
      await page.waitForFunction((full) => {
        const overlay = (navigator as Navigator & { windowControlsOverlay: { getTitlebarAreaRect: () => DOMRect } })
          .windowControlsOverlay
        return full ? overlay.getTitlebarAreaRect().x === 0 : overlay.getTitlebarAreaRect().x > 0
      }, fullscreen)
      for (const expanded of [true, false]) {
        const toggle = page.locator("[data-sidebar-toggle]")
        if ((await toggle.getAttribute("aria-expanded")) !== String(expanded)) await toggle.click()
        await page.waitForFunction((open) => {
          const width = document.querySelector(".sb-root")!.getBoundingClientRect().width
          return open ? width >= 230 : width === 0
        }, expanded)
        await page.waitForTimeout(250)
        const state = await geometry()
        check(
          fullscreen ? state.native.width === 0 : state.native.width > 60,
          `${scheme}/${fullscreen}/${expanded}: native safe area`,
        )
        check(
          state.toggle.x >= state.native.right && state.toggle.x - state.native.right <= 12,
          `${scheme}/${fullscreen}/${expanded}: toggle follows native edge`,
        )
        check(
          state.toggle.y >= 0 && state.toggle.y + state.toggle.height <= 48,
          `${scheme}/${fullscreen}/${expanded}: one top row`,
        )
        check(
          expanded ? state.sidebar.width >= 230 : state.sidebar.width === 0,
          `${scheme}/${fullscreen}/${expanded}: actual navigation occupancy`,
        )
        measurements.push({ scheme, fullscreen, expanded, ...state })
        await page.screenshot({
          path: path.join(
            output,
            `${scheme}-${fullscreen ? "fullscreen" : "window"}-${expanded ? "expanded" : "collapsed"}.png`,
          ),
        })
        await page.getByRole("button", { name: /打开侧边工作区|Open side workspace/ }).click()
        await page.waitForTimeout(350)
        const split = await geometry()
        measurements.push({ scheme, fullscreen, expanded, split: true, ...split })
        check(split.sidebar.width === state.sidebar.width, "split workspace retains navigation occupancy")
        check(split.toggle.x === Math.max(12, split.native.right), "split workspace keeps the native navigation anchor")
        const model = (await page.locator(".stb-selector-label").filter({ visible: true }).boundingBox())!
        check(
          model.x >= split.native.right && model.x + model.width <= split.header.right,
          "split model stays inside its column",
        )
        await page.screenshot({
          path: path.join(
            output,
            `${scheme}-${fullscreen ? "fullscreen" : "window"}-${expanded ? "expanded" : "collapsed"}-split.png`,
          ),
        })
        const hideSide = page.getByRole("button", { name: /隐藏侧边工作区|Hide side workspace/ })
        if (await hideSide.isVisible()) await hideSide.click()
        else {
          await page.getByRole("button", { name: /会话操作|Session actions/ }).click()
          await page.getByRole("menuitem", { name: /隐藏侧边工作区|Hide side workspace/ }).click()
        }
        await page.waitForTimeout(350)
      }
      if (fullscreen) {
        await page.reload()
        await page.locator("[data-sidebar-toggle]").waitFor()
        await page.locator(".stb-root").waitFor()
        check((await geometry()).native.width === 0, "fullscreen reload retains zero safe area")
      }
    }
  }
  await window.evaluate((win) => win.setFullScreen(false))
  await page.waitForFunction(
    () => document.querySelector(".desktop-native-titlebar")!.getBoundingClientRect().width > 0,
  )
  await window.evaluate((win) => win.maximize())
  check(await window.evaluate((win) => win.isMaximized()), "native maximize")
  await window.evaluate((win) => win.unmaximize())
  await window.evaluate((win) => win.minimize())
  await page.waitForTimeout(400)
  check(await window.evaluate((win) => win.isMinimized()), "native minimize")
  await window.evaluate((win) => {
    win.restore()
    win.show()
    win.focus()
  })
  check(!(await window.evaluate((win) => win.isMinimized())), "native restore")
  await window.evaluate((win) => win.webContents.setZoomFactor(2))
  await page.waitForTimeout(350)
  const zoom = await page.evaluate(() => {
    const native = document.querySelector(".desktop-native-titlebar")!.getBoundingClientRect()
    const first = document.querySelector(".stb-root button")!.getBoundingClientRect()
    const editor = document.querySelector('[role="textbox"][contenteditable]')!.getBoundingClientRect()
    return { nativeRight: native.right, firstLeft: first.left, editorBottom: editor.bottom, height: innerHeight }
  })
  measurements.push({ zoom: 2, ...zoom })
  check(zoom.firstLeft >= zoom.nativeRight, "200% zoom respects native controls")
  check(zoom.editorBottom <= zoom.height, "200% zoom keeps the editor reachable")
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "200% zoom has no document overflow",
  )
  await writeFile(
    path.join(output, "zoom-200.png"),
    Buffer.from(await window.evaluate(async (win) => (await win.capturePage()).toPNG().toString("base64")), "base64"),
  )
  await window.evaluate((win) => win.webContents.setZoomFactor(1))
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, measurements }, null, 2))
  console.log(`Passed ${checks.length} native checks; evidence: ${output}`)
} catch (error) {
  console.error(error)
  if (!page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {})
  await writeFile(path.join(output, "failure.txt"), `${error}\n${JSON.stringify(measurements, null, 2)}`)
  throw error
} finally {
  await app.close()
}
