import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { chromium, _electron, type BrowserContext, type Page, type WebSocketRoute } from "playwright-core"
import type { Settings } from "./settings"
import { atomicJSON } from "./evidence"
import { until } from "./runtime"

export async function productWindow(directory: string, url: string, settings: Settings, desktop: boolean) {
  const events: Array<{ at: number; type: string; value: unknown }> = []
  const active = new Set<WebSocketRoute>()
  let blocked = false
  let page: Page
  let browserContext: BrowserContext
  let close: () => Promise<void>
  let pid: number
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (desktop) {
    const artifact = settings.artifacts?.desktop
    if (!artifact) throw new Error("Desktop acceptance requires a frozen Desktop artifact")
    const entry = path.resolve(artifact.directory, artifact.entry)
    const executable = path.resolve(artifact.electronDirectory, artifact.executable)
    for (const [root, file] of [
      [artifact.directory, entry],
      [artifact.electronDirectory, executable],
    ] as const)
      if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("Desktop entry escapes its frozen artifact")
    const wrapper = path.join(directory, "isolated-electron.mjs")
    await Bun.write(
      wrapper,
      `import { app } from "electron"; app.setPath("userData", ${JSON.stringify(path.join(directory, "user-data"))}); await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    )
    const app = await _electron.launch({
      executablePath: executable,
      args: [wrapper, "--lang=en-US"],
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          SYNERGY_DESKTOP_CHANNEL: "dev",
          SYNERGY_DESKTOP_SERVER_MODE: "external",
          SYNERGY_DESKTOP_APP_URL: url,
          SYNERGY_DESKTOP_LOG_DIR: path.join(directory, "logs"),
          SYNERGY_DESKTOP_SHOW: "0",
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      timeout: settings.deadlineMs,
    })
    pid = app.process().pid!
    close = () => app.close()
    try {
      const origin = new URL(url).origin
      page = (await until(
        async () => {
          for (const candidate of app.windows())
            if (
              !candidate.isClosed() &&
              candidate.url().startsWith(origin) &&
              (await candidate.locator(".prompt-input-submit").count())
            )
              return candidate
        },
        Boolean,
        settings.deadlineMs,
      ))!
      browserContext = page.context()
    } catch (error) {
      await close()
      throw error
    }
  } else {
    if (!settings.chromium) throw new Error("Web acceptance requires frozen Chromium")
    const browser = await chromium.launch({ executablePath: settings.chromium, headless: true })
    close = () => browser.close()
    const cdp = await browser.newBrowserCDPSession()
    const processes = await cdp.send("SystemInfo.getProcessInfo")
    pid = processes.processInfo.find((process) => process.type === "browser")!.id
    await cdp.detach()
    browserContext = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })
    page = await browserContext.newPage()
  }
  const record = (type: string, value: unknown) => events.push({ at: Date.now(), type, value })
  page.on("pageerror", (error) => record("page-error", error.message))
  page.on("requestfailed", (request) => record("request-failed", { url: request.url(), error: request.failure() }))
  page.on("response", (response) => record("http", { url: response.url(), status: response.status() }))
  await browserContext.routeWebSocket("**/global/event/ws*", (socket) => {
    if (blocked) {
      socket.close({ code: 4001, reason: "Acceptance disconnection" })
      return
    }
    active.add(socket)
    record("ws-open", socket.url())
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      record("ws-client", String(message))
      upstream.send(message)
    })
    upstream.onMessage((message) => {
      record("ws-server", String(message))
      socket.send(message)
    })
    socket.onClose((code, reason) => {
      active.delete(socket)
      record("ws-close", { code, reason })
      upstream.close({ code, reason })
    })
  })
  page.setDefaultTimeout(Math.min(settings.deadlineMs, 60000))
  try {
    await page.goto(url)
    await page.locator(".prompt-input-submit").waitFor()
  } catch (error) {
    await close()
    throw error
  }
  return {
    page,
    events,
    pid,
    async disconnect() {
      if (!active.size) throw new Error("No active product event connection was observed")
      blocked = true
      for (const socket of active) socket.close({ code: 4001, reason: "Acceptance disconnection" })
      active.clear()
      record("injected-disconnect", { pid })
    },
    reconnect() {
      blocked = false
      record("reconnect-enabled", { pid })
    },
    async snapshot(name: string) {
      await page.screenshot({ path: path.join(directory, `${name}.png`) })
      await atomicJSON(path.join(directory, `${name}.json`), {
        url: page.url(),
        body: await page.locator("body").innerText(),
        control: await page.locator(".prompt-input-submit").getAttribute("aria-label"),
        icon: await page.locator(".prompt-input-submit").innerHTML(),
      })
    },
    async [Symbol.asyncDispose]() {
      try {
        await close()
      } finally {
        await atomicJSON(path.join(directory, "transport.json"), events)
      }
      await until(
        async () => {
          try {
            process.kill(pid, 0)
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
            return true
          }
        },
        Boolean,
        settings.deadlineMs,
      )
      await atomicJSON(path.join(directory, "closed.json"), { pid, exited: true })
    },
  }
}
