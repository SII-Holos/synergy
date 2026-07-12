import { app, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-native-page-pool-"))
  await app.whenReady()
  try {
    const pool = new BrowserNativePagePool()
    const input = {
      ownerKey: "scope:native-smoke:session:native-smoke",
      page: {
        id: "native-page-1",
        url: "about:blank",
        title: "",
        isLoading: false,
        lastActiveAt: null,
      },
      networkProxy: { server: "direct://", username: "unused", password: "unused" },
      downloadDir: directory,
      emit() {},
    }
    const first = await pool.create(input)
    const window = new BrowserWindow({ show: false })
    const view = pool.attach(window, input.ownerKey, input.page.id)
    view.setBounds({ x: 320, y: 48, width: 640, height: 480 })
    await first.execute({ type: "setViewport", width: 600, height: 400 })
    const resizedBounds = view.getBounds()
    if (resizedBounds.x !== 320 || resizedBounds.y !== 48) {
      throw new Error(`Native viewport resize moved the presentation to ${resizedBounds.x},${resizedBounds.y}.`)
    }
    if (resizedBounds.width !== 600 || resizedBounds.height !== 400) {
      throw new Error(`Native viewport resize did not apply 600x400: ${JSON.stringify(resizedBounds)}.`)
    }
    await first.execute({
      type: "evaluate",
      mode: "trusted",
      expression: `
        document.body.innerHTML = '<button id="open">Open details</button><dialog><button>Close</button></dialog><div id="scroll" style="height:40px;overflow:auto"><div style="height:400px">Scrollable</div></div>';
        document.querySelector('#open').addEventListener('click', () => document.querySelector('dialog').showModal());
        console.log('native-browser-log');
      `,
    })
    const hoverStartedAt = Date.now()
    await first.execute({
      type: "action",
      action: { type: "hover", target: { kind: "role", role: "button", name: "Open details" } },
    })
    if (Date.now() - hoverStartedAt > 2_000) throw new Error("Native hover exceeded the actionability budget.")
    await first.execute({
      type: "action",
      action: { type: "click", target: { kind: "role", role: "button", name: "Open details" } },
    })
    const dialog = await first.execute({
      type: "evaluate",
      mode: "readonly",
      expression: `document.querySelector('dialog').open`,
    })
    if (dialog.type !== "evaluation" || dialog.value !== true) throw new Error("Native dialog click did not open.")
    await first.execute({
      type: "evaluate",
      mode: "trusted",
      expression: `document.querySelector('dialog').close()`,
    })
    await first.execute({
      type: "action",
      action: { type: "scroll", target: { kind: "css", value: "#scroll" }, deltaX: 0, deltaY: 100 },
    })
    const scroll = await first.execute({
      type: "evaluate",
      mode: "readonly",
      expression: `document.querySelector('#scroll').scrollTop`,
    })
    if (scroll.type !== "evaluation" || Number(scroll.value) <= 0) throw new Error("Native target scroll did not move.")
    const consoleEntries = await first.execute({ type: "console", action: "list" })
    if (consoleEntries.type !== "data" || !JSON.stringify(consoleEntries.data).includes("native-browser-log")) {
      throw new Error("Native Browser console logs were not retrievable.")
    }
    const checkpoint = await first.execute({ type: "checkpoint", action: "capture" })
    if (
      checkpoint.type !== "data" ||
      typeof checkpoint.data !== "object" ||
      checkpoint.data === null ||
      !("viewport" in checkpoint.data)
    ) {
      throw new Error("Native page did not produce a checkpoint.")
    }
    const viewport = checkpoint.data.viewport as { width?: number; height?: number }
    if (!viewport.width || !viewport.height) throw new Error("Native page started with a zero-sized viewport.")
    pool.detach(window, input.ownerKey, input.page.id)
    window.destroy()
    await first.destroy()

    const second = await pool.create({ ...input, page: { ...input.page, id: "native-page-2" } })
    await second.destroy()
    await pool.destroy()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    app.quit()
  }
}
