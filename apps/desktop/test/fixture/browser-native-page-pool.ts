import { app, BrowserWindow, screen } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadWindowState } from "../../src/window-state.js"
import { BrowserNativeViewManager } from "../../src/browser-native-view.js"
import { BrowserNativePagePool } from "../../src/browser-native-page-pool.js"
import { BROWSER_PROTOCOL_VERSION, type BrowserHostPageEvent } from "@ericsanchezok/synergy-browser-core"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-native-page-pool-"))
  await app.whenReady()
  console.log("Native Browser geometry smoke: ready")
  try {
    const window = new BrowserWindow({ width: 1300, height: 800, show: false })
    await window.loadURL("about:blank")
    window.showInactive()
    const pool = new BrowserNativePagePool({ captureWindow: () => window })
    let hostReady = false
    let onDialog: ((event: Extract<BrowserHostPageEvent, { type: "dialog.opened" }>) => void) | undefined
    const input = {
      ownerKey: "scope:native-smoke:session:native-smoke",
      profile: { id: "personal", partition: "persist:synergy-browser-smoke", revision: 0 },
      page: {
        id: "native-page-1",
        url: "about:blank",
        title: "",
        isLoading: false,
        lastActiveAt: null,
      },
      networkProxy: { server: "direct://", username: "unused", password: "unused" },
      downloadDir: directory,
      emit(event: BrowserHostPageEvent) {
        if (event.type === "host.status" && event.status === "ready") hostReady = true
        if (event.type === "dialog.opened") onDialog?.(event)
        if (event.type === "page.error") console.error("Native geometry: page error", event.message)
      },
    }
    const first = await pool.create(input)
    const viewportSize = async () => {
      const result = await first.execute({
        type: "evaluate",
        mode: "readonly",
        expression: "({ width: innerWidth, height: innerHeight })",
      })
      assert.equal(result.type, "evaluation")
      return (result.type === "evaluation" ? result.value : undefined) as { width: number; height: number }
    }
    assert.deepEqual(
      await viewportSize(),
      { width: 1280, height: 720 },
      "Detached pages need a usable default viewport",
    )
    const initialChildren = [...window.contentView.children]
    const initialFocus = window.webContents.isFocused()
    assert.equal((await first.execute({ type: "screenshot", fullPage: true })).type, "screenshot")
    assert.deepEqual(
      window.contentView.children,
      initialChildren,
      "A background capture releases its native attachment",
    )
    assert.equal(window.webContents.isFocused(), initialFocus, "A background capture cannot steal focus")
    await first.execute({ type: "setViewport", width: 900, height: 600 })
    assert.deepEqual(
      await viewportSize(),
      { width: 900, height: 600 },
      "Legacy explicit viewport remains fixed when detached",
    )
    assert.equal((await first.execute({ type: "screenshot", fullPage: true })).type, "screenshot")
    await first.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
    assert.deepEqual(await viewportSize(), { width: 1280, height: 720 }, "Detached fit restores the native viewport")
    for (const answer of ["Edited draft", "", null]) {
      let requested = false
      onDialog = (event) => {
        if (event.dialogType !== "prompt" || event.defaultValue !== "Default draft")
          throw new Error("Prompt did not preserve its type and default.")
        requested = true
        void first.execute({
          type: "dialog.respond",
          requestId: event.requestId,
          accept: answer !== null,
          ...(answer !== null ? { promptText: answer } : {}),
        })
      }
      const result = await first.execute({
        type: "evaluate",
        mode: "trusted",
        expression: "prompt('Name this draft', 'Default draft')",
      })
      if (!requested || result.type !== "evaluation" || result.value !== answer)
        throw new Error(`Native prompt did not return its response: ${JSON.stringify(result)}.`)
    }
    onDialog = undefined
    const area = screen.getPrimaryDisplay().workArea
    await fs.writeFile(
      path.join(directory, "window-state.json"),
      JSON.stringify({
        width: area.width * 2,
        height: area.height * 2,
        x: area.x + area.width * 3,
        y: area.y - area.height * 3,
      }),
    )
    const restored = await loadWindowState(directory)
    if (
      restored.x === undefined ||
      restored.y === undefined ||
      restored.x < area.x ||
      restored.y < area.y ||
      restored.x + restored.width > area.x + area.width ||
      restored.y + restored.height > area.y + area.height
    )
      throw new Error("Restored window is outside the available work area.")
    window.setBounds(restored)
    window.webContents.setZoomFactor(1.25)
    const firstManager = new BrowserNativeViewManager(window, pool, () => {})
    const firstRequest = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: input.ownerKey,
      pageId: input.page.id,
      bounds: { x: 256, y: 40, width: 640, height: 480 },
    }
    await firstManager.attach(firstRequest)
    let view = window.contentView.children.at(-1)! as import("electron").WebContentsView
    window.showInactive()
    await waitFor(
      async () => (await view.webContents.executeJavaScript("document.visibilityState")) === "visible",
      2_000,
      "visible native presentation",
    )
    let recovered = false
    const unsubscribe = pool.onGeneration(input.ownerKey, input.page.id, (next) => {
      view = next
      recovered = true
    })
    const nativeBounds = { x: 320, y: 50, width: 800, height: 600 }
    assert.deepEqual(view.getBounds(), nativeBounds, "Manager scales renderer bounds by host zoom")
    console.log(
      "Native geometry: attached",
      JSON.stringify({
        bounds: view.getBounds(),
        viewport: await viewportSize(),
        zoom: view.webContents.getZoomFactor(),
      }),
    )
    await waitFor(
      async () => {
        const size = await viewportSize()
        return size.width === 800 && size.height === 600
      },
      2_000,
      "natural attached viewport",
    )
    await observe("attached fixed viewport", () =>
      first.execute({ type: "setViewport", mode: "fixed", width: 600, height: 400 }),
    )
    assert.deepEqual(view.getBounds(), nativeBounds, "Fixed viewport must not resize native presentation")
    assert.deepEqual(await viewportSize(), { width: 600, height: 400 })
    assert.equal(
      (await observe("attached fixed screenshot", () => first.execute({ type: "screenshot", fullPage: true }))).type,
      "screenshot",
    )
    firstManager.resize(input.ownerKey, input.page.id, { x: 256, y: 40, width: 560, height: 360 })
    const resizedBounds = { x: 320, y: 50, width: 700, height: 450 }
    assert.deepEqual(view.getBounds(), resizedBounds)
    assert.deepEqual(
      await viewportSize(),
      { width: 600, height: 400 },
      "Manager resize cannot clear explicit fixed metrics",
    )
    await observe("attached fit viewport", () =>
      first.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 }),
    )
    assert.deepEqual(view.getBounds(), resizedBounds, "Fit ignores supplied dimensions for native bounds")
    await waitFor(
      async () => {
        const size = await viewportSize()
        return size.width === 700 && size.height === 450
      },
      2_000,
      "fit restores natural viewport after fixed metrics",
    )
    firstManager.resize(input.ownerKey, input.page.id, { x: 256, y: 40, width: 512, height: 320 })
    await waitFor(
      async () => {
        const size = await viewportSize()
        return size.width === 640 && size.height === 400
      },
      2_000,
      "natural viewport after manager resize",
    )
    assert.deepEqual(view.getBounds(), { x: 320, y: 50, width: 640, height: 400 })
    const contentId = view.webContents.id
    firstManager.detach(input.ownerKey, input.page.id)
    assert.deepEqual(await viewportSize(), { width: 640, height: 400 }, "Detached fit retains the last native size")
    assert.equal(
      (await observe("detached fit screenshot", () => first.execute({ type: "screenshot", fullPage: true }))).type,
      "screenshot",
    )
    await first.execute({ type: "setViewport", width: 500, height: 300 })
    await firstManager.attach({ ...firstRequest, bounds: { x: 256, y: 40, width: 512, height: 320 } })
    assert.equal(view.webContents.id, contentId, "Attachment must preserve the browsing context")
    assert.deepEqual(await viewportSize(), { width: 500, height: 300 }, "Attachment preserves explicit Agent viewport")
    firstManager.detach(input.ownerKey, input.page.id)
    assert.deepEqual(await viewportSize(), { width: 500, height: 300 }, "Detach preserves explicit Agent viewport")
    assert.equal(
      (await observe("detached fixed screenshot", () => first.execute({ type: "screenshot", fullPage: true }))).type,
      "screenshot",
    )
    await first.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
    assert.deepEqual(await viewportSize(), { width: 640, height: 400 }, "Detached fit restores the last native size")
    await firstManager.attach({ ...firstRequest, bounds: { x: 256, y: 40, width: 512, height: 320 } })
    await waitFor(
      async () => {
        const size = await viewportSize()
        return size.width === 640 && size.height === 400
      },
      2_000,
      "reattached fit viewport",
    )
    console.log(
      "ACCEPTED: one bounds owner, zoom-scaled natural viewport, detached/attached fixed-fit and roundtrip identity",
    )
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

    const rendererProcessId = view.webContents.getOSProcessId()
    if (rendererProcessId <= 0 || rendererProcessId === window.webContents.getOSProcessId()) {
      throw new Error("Native page did not receive an isolated renderer process.")
    }
    process.kill(rendererProcessId, "SIGKILL")
    // host.status "ready" is emitted only after the pool clears its recovery
    // guard, so waiting for it guarantees the recovered page accepts CDP
    // commands without racing the restarting guard.
    await waitFor(() => recovered && hostReady, 10_000, "native renderer recovery readiness")
    const recoveredPage = first.state()
    if (recoveredPage.id !== input.page.id) throw new Error("Native renderer recovery changed the stable page ID.")
    const recoveredEvaluation = await first.execute({
      type: "evaluate",
      mode: "readonly",
      expression: "document.readyState",
    })
    if (recoveredEvaluation.type !== "evaluation") {
      throw new Error("Recovered native renderer did not accept a CDP command.")
    }
    assert.deepEqual(view.getBounds(), { x: 320, y: 50, width: 640, height: 400 })
    assert.deepEqual(
      await viewportSize(),
      { width: 640, height: 400 },
      "Recovery preserves manager-owned natural viewport",
    )
    unsubscribe()
    firstManager.destroy()
    await first.destroy()

    const secondInput = {
      ...input,
      ownerKey: "scope:native-smoke:session:workspace-first",
      page: { ...input.page, id: "native-page-2" },
    }
    const second = await pool.create(secondInput)
    const secondView = pool.attach(window, secondInput.ownerKey, secondInput.page.id)
    await second.execute({ type: "navigate", url: "about:blank", source: "user" })
    if (second.state().id !== secondInput.page.id || secondView.webContents.isDestroyed()) {
      throw new Error("Workspace-first native page creation did not produce a usable stable page.")
    }
    const manager = new BrowserNativeViewManager(window, pool, () => {})
    const request = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: secondInput.ownerKey,
      pageId: secondInput.page.id,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    }
    await second.execute({
      type: "evaluate",
      mode: "trusted",
      expression: "document.body.innerHTML = '<input id=kept value=retained>'",
    })
    await manager.attach({ ...request, visible: false })
    if (secondView.getVisible() || secondView.webContents.isDestroyed())
      throw new Error("Native overlay did not hide a live view.")
    await manager.attach({ ...request, visible: true })
    const retained = await second.execute({
      type: "evaluate",
      mode: "readonly",
      expression: "document.querySelector('#kept').value",
    })
    if (
      !secondView.getVisible() ||
      retained.type !== "evaluation" ||
      retained.value !== "retained" ||
      second.state().id !== secondInput.page.id
    )
      throw new Error("Native overlay changed the page or its input state.")

    await second.execute({
      type: "evaluate",
      mode: "trusted",
      expression: `
        document.body.innerHTML = '<button id="count">Increment</button><output id="counted">0</output><input aria-label="Draft">';
        document.querySelector('#count').addEventListener('click', () => {
          document.querySelector('#counted').textContent = String(Number(document.querySelector('#counted').textContent) + 1);
        });
      `,
    })
    await second.execute({ type: "snapshot" }, "background-agent")
    const windowFocused = window.isFocused()
    let clicks = 0
    for (const presentation of ["visible", "covered", "detached"] as const) {
      if (presentation === "covered") await manager.attach({ ...request, visible: false })
      if (presentation === "detached") manager.detach(secondInput.ownerKey, secondInput.page.id)
      await second.execute(
        { type: "action", action: { type: "click", target: { kind: "css", value: "#count" } } },
        "background-agent",
      )
      const result = await secondView.webContents.executeJavaScript(
        "Number(document.querySelector('#counted').textContent)",
      )
      assert.equal(result, ++clicks, `${presentation} Agent click takes effect`)
      const observed = await second.execute({ type: "snapshot" }, "background-agent")
      assert.equal(observed.userChanges, undefined, "Agent input is not reported as human input")
      assert.equal(window.isFocused(), windowFocused, "Agent commands do not activate the window")
    }
    await manager.attach(request)
    const clickPoint = await secondView.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('#count').getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`)
    secondView.webContents.sendInputEvent({ type: "mouseDown", ...clickPoint, button: "left", clickCount: 1 })
    secondView.webContents.sendInputEvent({ type: "mouseUp", ...clickPoint, button: "left", clickCount: 1 })
    await waitFor(
      async () =>
        Number(await secondView.webContents.executeJavaScript("document.querySelector('#counted').textContent")) ===
        clicks + 1,
      2_000,
      "native user click",
    )
    await assert.rejects(
      second.execute(
        { type: "action", action: { type: "click", target: { kind: "css", value: "#count" } } },
        "background-agent",
      ),
      /Read the page again before acting/,
    )
    const changed = await second.execute({ type: "snapshot" }, "background-agent")
    assert.match(changed.userChanges ?? "", /pointer: 1/)
    const peerChanged = await second.execute({ type: "snapshot" }, "peer-agent")
    assert.match(peerChanged.userChanges ?? "", /pointer: 1/)
    await second.execute(
      { type: "action", action: { type: "click", target: { kind: "css", value: "#count" } } },
      "background-agent",
    )
    assert.equal((await second.execute({ type: "snapshot" }, "background-agent")).userChanges, undefined)
    manager.destroy()
    await second.destroy()
    window.destroy()
    await pool.destroy()
  } catch (error) {
    console.error("Native geometry: failed before cleanup", error)
    throw error
  } finally {
    console.log("Native geometry: cleanup begin")
    await fs.rm(directory, { recursive: true, force: true })
    console.log("Native geometry: cleanup end")
    app.quit()
  }
}

async function waitFor(read: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  console.log("Native geometry: wait begin", label)
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await read()) {
      console.log("Native geometry: wait end", label)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

async function observe<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now()
  console.log("Native geometry: operation begin", label)
  try {
    return await operation()
  } finally {
    console.log("Native geometry: operation end", label, `${Date.now() - started}ms`)
  }
}
