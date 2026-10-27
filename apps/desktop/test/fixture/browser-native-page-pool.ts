import { app, BrowserWindow, nativeImage, screen } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
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
  const website = createServer((_request, response) =>
    response.end("<!doctype html><body>Native capture navigation</body>"),
  )
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
    let captures = 0
    const assertFullPageCapture = async (width: number, handle = first, page = input) => {
      const light = captures++ % 2 === 1
      const density = await handle.execute({ type: "evaluate", mode: "readonly", expression: "devicePixelRatio" })
      assert.ok(density.type === "evaluation" && typeof density.value === "number" && density.value > 0)
      const pixels = { width: Math.round(width * density.value), height: Math.round(2048 * density.value) }
      await handle.execute({
        type: "evaluate",
        mode: "trusted",
        expression: `document.body.style.cssText = 'margin:0;width:${width}px;height:2048px;background:linear-gradient(${light ? "#ffffff" : "#000000"} 0 50%,${light ? "#000000" : "#ffffff"} 50% 100%)'; true`,
      })
      await handle.execute({
        type: "evaluate",
        mode: "trusted",
        expression: `globalThis.__captureEvents = []; if (!globalThis.__captureListening) { globalThis.__captureListening = true; for (const event of ['visibilitychange', 'focus', 'blur']) addEventListener(event, () => globalThis.__captureEvents.push(event)); } true`,
      })
      const captureView = pool.find(page.ownerKey, page.page.id)!.generation.view
      const children = [...window.contentView.children]
      const attached = children.includes(captureView)
      const visible = captureView.getVisible()
      const focused = window.webContents.isFocused()
      assert.equal(window.isVisible(), true, "Capture has a visible native host")
      assert.equal(window.isMinimized(), false, "Capture host is not minimized")
      const capture = handle.execute({ type: "screenshot", fullPage: true })
      assert.equal(window.contentView.children.includes(captureView), true, "Capture uses the same native view")
      assert.equal(captureView.getVisible(), attached && visible, "Detached capture does not show its native view")
      const result = await capture
      assert.equal(pool.find(page.ownerKey, page.page.id)!.generation.view, captureView)
      assert.deepEqual(window.contentView.children, children, "Capture restores native parent membership")
      assert.equal(captureView.getVisible(), visible, "Capture restores native visibility")
      assert.equal(window.webContents.isFocused(), focused, "Capture does not steal native focus")
      const pageEvents = await handle.execute({
        type: "evaluate",
        mode: "trusted",
        expression: "globalThis.__captureEvents",
      })
      assert.equal(pageEvents.type, "evaluation")
      assert.deepEqual(
        pageEvents.type === "evaluation" ? pageEvents.value : undefined,
        [],
        "Capture does not dispatch visibility or focus events",
      )
      assert.equal(result.type, "screenshot")
      if (result.type !== "screenshot") throw new Error("Expected a full-page screenshot")
      assert.deepEqual({ width: result.width, height: result.height }, { width, height: 2048 })
      const image = nativeImage.createFromDataURL(result.dataUrl)
      assert.deepEqual(image.getSize(), pixels, "PNG contains the full CSS page at the actual device pixel ratio")
      assert.deepEqual(
        [...image.crop({ x: 0, y: 0, width: 1, height: 1 }).toBitmap()],
        light ? [255, 255, 255, 255] : [0, 0, 0, 255],
        "Capture contains the latest document paint, not a stale surface",
      )
      assert.deepEqual(
        [...image.crop({ x: 0, y: pixels.height - 1, width: 1, height: 1 }).toBitmap()],
        light ? [0, 0, 0, 255] : [255, 255, 255, 255],
        "Full-page capture retains pixels below the viewport",
      )
    }
    const initialChildren = [...window.contentView.children]
    const initialFocus = window.webContents.isFocused()
    await assertFullPageCapture(1280)
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
    await assertFullPageCapture(900)
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
    await first.execute({ type: "setViewport", mode: "fixed", width: 600, height: 400 })
    assert.deepEqual(view.getBounds(), nativeBounds, "Fixed viewport must not resize native presentation")
    assert.deepEqual(await viewportSize(), { width: 600, height: 400 })
    await assertFullPageCapture(600)
    firstManager.resize(input.ownerKey, input.page.id, { x: 256, y: 40, width: 560, height: 360 })
    const resizedBounds = { x: 320, y: 50, width: 700, height: 450 }
    assert.deepEqual(view.getBounds(), resizedBounds)
    assert.deepEqual(
      await viewportSize(),
      { width: 600, height: 400 },
      "Manager resize cannot clear explicit fixed metrics",
    )
    await first.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })
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
    await assertFullPageCapture(640)
    await first.execute({ type: "setViewport", width: 500, height: 300 })
    await firstManager.attach({ ...firstRequest, bounds: { x: 256, y: 40, width: 512, height: 320 } })
    assert.equal(view.webContents.id, contentId, "Attachment must preserve the browsing context")
    assert.deepEqual(await viewportSize(), { width: 500, height: 300 }, "Attachment preserves explicit Agent viewport")
    firstManager.detach(input.ownerKey, input.page.id)
    assert.deepEqual(await viewportSize(), { width: 500, height: 300 }, "Detach preserves explicit Agent viewport")
    await assertFullPageCapture(500)
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
    await assertFullPageCapture(640)
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
    website.listen(0, "127.0.0.1")
    await once(website, "listening")
    const address = website.address()
    assert.ok(address && typeof address !== "string")
    await second.execute({ type: "navigate", url: `http://a.localhost:${address.port}/`, source: "agent" })
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
    const humanFrame = new Promise<void>((resolve) =>
      secondView.webContents.beginFrameSubscription(false, (image) => {
        assert.equal(image.isEmpty(), false, "Human presentation has produced an actual frame")
        secondView.webContents.endFrameSubscription()
        resolve()
      }),
    )
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

    await humanFrame
    await second.execute({ type: "setViewport", mode: "fixed", width: 450, height: 320 })
    manager.detach(secondInput.ownerKey, secondInput.page.id)
    console.log("Native capture: first screenshot after human presentation and fixed detach")
    await assertFullPageCapture(450, second, secondInput)
    await second.execute({ type: "setViewport", mode: "fit", width: 1, height: 1 })

    const generation = pool.find(secondInput.ownerKey, secondInput.page.id)!.generation
    for (const [index, host] of ["b.localhost", "c.localhost"].entries()) {
      const previousProcess = secondView.webContents.mainFrame.processId
      await second.execute({ type: "navigate", url: `http://${host}:${address.port}/`, source: "agent" })
      assert.notEqual(
        secondView.webContents.mainFrame.processId,
        previousProcess,
        "Cross-site navigation replaces the primary renderer",
      )
      assert.equal(
        pool.find(secondInput.ownerKey, secondInput.page.id)!.generation,
        generation,
        "Navigation keeps the pool generation and native view",
      )
      if (index === 1) {
        await manager.attach(request)
        manager.detach(secondInput.ownerKey, secondInput.page.id)
      }
      console.log(`Native capture: process swap ${index + 1}, ${index === 0 ? "never shown" : "shown then detached"}`)
      await assertFullPageCapture(750, second, secondInput)
    }

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
      if (presentation === "visible") await manager.attach({ ...request, visible: true })
      if (presentation === "covered") await manager.attach({ ...request, visible: false })
      if (presentation === "detached") manager.detach(secondInput.ownerKey, secondInput.page.id)
      assert.equal(
        window.contentView.children.includes(secondView),
        presentation !== "detached",
        `${presentation} Agent input has the expected native parent membership`,
      )
      if (presentation !== "detached") {
        assert.equal(secondView.getVisible(), presentation === "visible", `${presentation} native view visibility`)
      }
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
  } finally {
    website.closeAllConnections()
    website.close()
    await fs.rm(directory, { recursive: true, force: true })
    app.quit()
  }
}

async function waitFor(read: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}
