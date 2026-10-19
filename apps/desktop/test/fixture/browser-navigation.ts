import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"
import type { BrowserHostPageEvent } from "@ericsanchezok/synergy-browser-core"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  await app.whenReady()
  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      const timer = setTimeout(() => response.end("<title>Slow page</title><p>Loaded</p>"), 11_000)
      response.once("close", () => clearTimeout(timer))
      return
    }
    response.end('<title>Form</title><input id="draft"><iframe src="http://127.0.0.1:1/fail"></iframe>')
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const window = new BrowserWindow({ show: false })
  const events: BrowserHostPageEvent[] = []
  const pool = new BrowserNativePagePool({ captureWindow: () => window })
  try {
    const started = performance.now()
    const page = await pool.create({
      ownerKey: "navigation-fixture",
      profile: { id: "fixture", partition: "synergy-browser-navigation-fixture", revision: 0 },
      page: { id: "page", url: `${url}/slow`, title: "", isLoading: false, lastActiveAt: null },
      networkProxy: { server: "direct://", username: "", password: "" },
      downloadDir: app.getPath("temp"),
      emit: (event) => events.push(event),
    })
    assert(performance.now() - started < 3_000, "Creating a page must not wait for the website")
    assert.equal(page.state().navigation?.requestedURL, `${url}/slow`)
    assert.equal(page.state().isLoading, true)
    await waitFor(() => page.state().navigation?.phase === "completed", 14_000)
    assert.equal(page.state().title, "Slow page")
    assert.equal(events.filter((event) => event.type === "page.error").length, 0)
    await page.execute({ type: "navigate", source: "user", url: `${url}/form` })
    await waitFor(() => page.state().title === "Form" && !page.state().isLoading, 3_000)
    const entry = pool.find("navigation-fixture", "page")!
    const contents = entry.generation.contents
    await contents.executeJavaScript("document.querySelector('input').value = 'unsaved draft'")
    const contentsId = contents.id
    const original = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = (method, ...args) =>
      method === "Page.navigate" ? new Promise(() => {}) : original(method, ...args)
    try {
      await assert.rejects(page.execute({ type: "navigate", source: "agent", url: `${url}/unknown` }), {
        code: "browser_cdp_timeout",
        retryable: false,
      })
    } finally {
      contents.debugger.sendCommand = original
    }
    assert.equal(pool.find("navigation-fixture", "page")!.generation.contents.id, contentsId)
    assert.equal(await contents.executeJavaScript("document.querySelector('input').value"), "unsaved draft")
    await page.execute({ type: "navigate", source: "user", url: `${url}/slow` })
    await page.execute({ type: "stop" })
    await page.execute({ type: "navigate", source: "user", url: `${url}/form` })
    await waitFor(() => page.state().title === "Form" && !page.state().isLoading, 3_000)
    assert.equal(events.filter((event) => event.type === "page.error").length, 0)
    console.log(
      "ACCEPTED: >10s website response, immediate native creation, retained unsaved form after CDP timeout, stop and subsequent navigation",
    )
  } finally {
    await pool.destroy()
    window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  app.quit()
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Navigation fixture timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
