import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { once } from "node:events"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"
import { BrowserNativeViewManager } from "../../src/browser-native-view.js"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 900, height: 600 })
  const background = process.env.SYNERGY_DESKTOP_BACKGROUND_TEST === "1"
  let activations = 0
  window.on("focus", () => activations++)
  await window.loadURL("data:text/html,<h1>Shell</h1><iframe></iframe>")
  if (!background) window.showInactive()
  const pool = new BrowserNativePagePool({ captureWindow: () => window })
  const ownerKey = "scope:presentation"
  const pageId = "presentation-page"
  const page = await pool.create({
    ownerKey,
    profile: { id: "personal", partition: "presentation-fixture", revision: 0 },
    page: { id: pageId, url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
    networkProxy: { server: "direct://", username: "unused", password: "unused" },
    downloadDir: app.getPath("temp"),
    emit() {},
  })
  const manager = new BrowserNativeViewManager(window, pool, () => {})
  const request = {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    ownerKey,
    pageId,
    bounds: { x: 400, y: 80, width: 500, height: 500 },
  }
  await manager.attach(request)
  const view = pool.find(ownerKey, pageId)!.generation.view
  const id = view.webContents.id
  await view.webContents.executeJavaScript(
    "document.body.innerHTML = '<input id=draft>'; document.querySelector('#draft').value = 'unsaved'",
  )
  await window.webContents.executeJavaScript(
    "location.hash = 'task'; document.querySelector('iframe').src = 'about:blank#frame'",
  )
  assert.ok(window.contentView.children.includes(view), "Same-document and subframe navigation preserve presentation")
  await window.loadURL("data:text/html,<h1>Reloaded shell</h1>")
  assert.ok(
    !window.contentView.children.includes(view),
    "Replacing the shell document must detach its old native overlay",
  )
  assert.equal(view.webContents.id, id)
  assert.equal(await view.webContents.executeJavaScript("document.querySelector('#draft').value"), "unsaved")
  await manager.attach(request)
  assert.ok(window.contentView.children.includes(view), "A new shell can reattach the retained page")
  const gone = once(window.webContents, "render-process-gone")
  process.kill(window.webContents.getOSProcessId(), "SIGKILL")
  await gone
  assert.ok(!window.contentView.children.includes(view), "A crashed shell must release its native overlay")
  await assert.rejects(manager.attach(request), /document/i)
  await window.loadURL("data:text/html,<h1>Recovered shell</h1>")
  await manager.attach(request)
  assert.equal(view.webContents.id, id)
  assert.equal(await view.webContents.executeJavaScript("document.querySelector('#draft').value"), "unsaved")
  manager.destroy()
  assert.ok(!window.contentView.children.includes(view))
  await page.destroy()
  if (background) {
    assert.equal(window.isVisible(), false)
    assert.equal(activations, 0)
  }
  window.destroy()
  console.log("ACCEPTED: shell reload and renderer loss detach presentation while preserving the native document")
  app.exit(0)
}
