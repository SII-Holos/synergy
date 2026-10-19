import { app, webContents } from "electron"
import assert from "node:assert/strict"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"
import type { BrowserHostPageEvent } from "@ericsanchezok/synergy-browser-core"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
async function run() {
  await app.whenReady()
  const baseline = webContents.getAllWebContents().length
  const events: BrowserHostPageEvent[] = []
  const pool = new BrowserNativePagePool()
  app.once("web-contents-created", (_event, contents) => {
    const send = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = (method, ...args) =>
      method === "Page.enable" ? new Promise(() => {}) : send(method, ...args)
  })
  const started = performance.now()
  await assert.rejects(
    pool.create({
      ownerKey: "initialization",
      profile: { id: "fixture", partition: "synergy-browser-init", revision: 0 },
      page: {
        id: "init",
        url: "https://example.invalid/?token=private",
        title: "",
        isLoading: false,
        lastActiveAt: null,
      },
      networkProxy: { server: "direct://", username: "", password: "" },
      downloadDir: app.getPath("temp"),
      emit: (event) => events.push(event),
    }),
    { code: "browser_native_init_failed", retryable: true },
  )
  const elapsed = performance.now() - started
  assert(elapsed >= 29_000 && elapsed < 35_000)
  assert(
    events.some(
      (event) => event.type === "page.stage" && event.stage === "failed" && event.failurePhase === "native.guards",
    ),
  )
  assert.equal(webContents.getAllWebContents().length, baseline)
  assert(!JSON.stringify(events.filter((event) => event.type === "page.stage")).includes("private"))
  await pool.destroy()
  console.log(
    JSON.stringify({
      accepted: "stalled initialization is classified and released within the shared budget",
      elapsedMs: elapsed,
      stages: events.filter((event) => event.type === "page.stage"),
    }),
  )
  app.quit()
}
