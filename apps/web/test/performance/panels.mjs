import path from "node:path"
const [repo, home] = process.argv.slice(2),
  { chromium } = await import(path.join(repo, "apps/web/node_modules/playwright/index.mjs")),
  manifest = await Bun.file(path.join(home, "manifest.json")).json(),
  browser = await chromium.launch({ headless: true, args: ["--js-flags=--expose-gc"] }),
  page = await browser.newPage({ viewport: { width: 1728, height: 1080 } }),
  errors = []
page.on("pageerror", (e) => {
  errors.push(e.stack)
  console.log("PAGE_ERROR", e.stack)
})
await page.addInitScript(() => {
  const Socket = window.WebSocket
  window.__fixtureSockets = []
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args)
      window.__fixtureSockets.push(this)
    }
  }
})
const go = async (target) => {
  await page.evaluate((route) => {
    const a = document.createElement("a")
    a.href = route
    document.body.append(a)
    a.click()
    a.remove()
  }, target.route)
  await page.waitForFunction((route) => location.pathname === route, target.route)
  await page.waitForTimeout(250)
}
try {
  console.log("STEP goto")
  const firstRead = Promise.withResolvers()
  const continued = Promise.withResolvers()
  const delayed = `**/session/${manifest.sessions[3].id}/timeline/page**`
  let delayedReads = 0
  await page.route(delayed, async (route) => {
    delayedReads++
    await firstRead.promise
    await route.continue()
    continued.resolve()
  })
  await page.goto(manifest.origin + manifest.sessions[3].route, { waitUntil: "domcontentloaded" })
  const prompt = page.locator('[data-component="prompt-input"]:visible')
  await prompt.fill("Cold navigation draft remains editable")
  const coldShellAvailable = await prompt.isVisible()
  console.log("STEP side")
  await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
  const side = page.locator(".workbench-surface--side:visible")
  await side.waitFor()
  firstRead.resolve()
  await continued.promise
  await page.unroute(delayed)
  await page.waitForLoadState("networkidle")
  console.log("STEP notes")
  await side
    .getByRole("button", { name: /^Notes/ })
    .first()
    .click()
  console.log("STEP note")
  await side.getByText("Fixture note 3", { exact: true }).click()
  const editor = side.locator('[contenteditable="true"]').first()
  await editor.waitFor()
  console.log("STEP edit")
  await editor.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" retained edit")
  const node = await editor.elementHandle(),
    before = await editor.innerText()
  const noteContinuity = []
  const inspectNote = async (stage) => {
    noteContinuity.push(
      await node.evaluate(
        (el, stage) => ({
          stage,
          connected: el.isConnected,
          session: el.closest("[data-session-resident]")?.getAttribute("data-session-resident"),
          panel: el.closest("[data-resident-panel]")?.getAttribute("data-resident-panel"),
          residents: [...document.querySelectorAll("[data-session-resident]")].map((el) =>
            el.getAttribute("data-session-resident"),
          ),
        }),
        stage,
      ),
    )
  }
  await inspectNote("before-away")
  console.log("STEP away")
  await go(manifest.sessions[4])
  await inspectNote("after-away")
  const hiddenNoteRequests = []
  let checkHidden = true
  const onRequest = (request) => {
    if (checkHidden && new URL(request.url()).pathname.startsWith("/note/") && request.method() === "GET")
      hiddenNoteRequests.push(new URL(request.url()).pathname)
  }
  page.on("request", onRequest)
  const previousSockets = await page.evaluate(() => {
    const count = window.__fixtureSockets.length
    for (const socket of window.__fixtureSockets) socket.close(1000, "Fixture recovery")
    return count
  })
  await page.waitForFunction((count) => window.__fixtureSockets.length > count, previousSockets)
  await page.waitForLoadState("networkidle")
  await page.waitForTimeout(1800)
  checkHidden = false
  page.off("request", onRequest)
  await inspectNote("after-reconnect")
  console.log("STEP back")
  await go(manifest.sessions[3])
  await page.waitForTimeout(500)
  const noteState = await node.evaluate((el) => ({
    connected: el.isConnected,
    height: el.getBoundingClientRect().height,
    text: el.textContent,
  }))
  const sameNote = noteState.connected && noteState.height > 0 && noteState.text.includes("retained edit")
  console.log("STEP newtab")
  await side.getByRole("button", { name: "New tab", exact: true }).click()
  await side
    .getByRole("button", { name: /^Files/ })
    .first()
    .click()
  await page.waitForTimeout(700)
  await side.getByText("README.md", { exact: true }).click()
  const file = side.locator(".file-markdown-preview")
  await file.waitFor()
  const fileNode = await file.elementHandle()
  const scrollNode = await file.evaluateHandle((element) => {
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        parent.scrollTop = 350
        return parent
      }
    }
    throw Error("File fixture must have a scrollable reader")
  })
  await go(manifest.sessions[4])
  await go(manifest.sessions[3])
  const sameFile = await fileNode.evaluate(
    (element) => element.isConnected && element.getBoundingClientRect().height > 0,
  )
  const fileScroll = await scrollNode.evaluate((element) => element.scrollTop)
  await side.getByRole("button", { name: "New tab", exact: true }).click()
  await side
    .getByRole("button", { name: /^Task details/ })
    .first()
    .click()
  await side.locator(".context-activity .context-section-heading button").click()
  const execution = side.locator(".execution-panel")
  const search = execution.locator(".execution-search input")
  await search.fill("Fixture")
  const executionNode = await execution.elementHandle()
  await go(manifest.sessions[4])
  await go(manifest.sessions[3])
  const sameExecution = await executionNode.evaluate(
    (element) =>
      element.isConnected &&
      element.getBoundingClientRect().height > 0 &&
      element.querySelector(".execution-search input")?.value === "Fixture",
  )
  await page.screenshot({ path: path.join(home, "panels.png") })
  const cdp = await page.context().newCDPSession(page),
    heaps = []
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const session of manifest.sessions) await go(session)
    await cdp.send("Performance.enable")
    await page.waitForLoadState("networkidle")
    await cdp.send("HeapProfiler.collectGarbage")
    const metrics = await cdp.send("Performance.getMetrics")
    heaps.push({
      sessionResidents: await page.locator("[data-session-resident]").count(),
      panelResidents: await page.locator("[data-resident-panel]").count(),
      heap: metrics.metrics.find((v) => v.name === "JSHeapUsedSize")?.value,
    })
  }
  const result = {
    coldShellAvailable,
    delayedReads,
    sameNote,
    noteState,
    noteContinuity,
    sameFile,
    sameExecution,
    fileScroll,
    hiddenNoteRequests,
    before,
    errors,
    heaps,
  }
  await Bun.write(path.join(home, "panel-report.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (
    !coldShellAvailable ||
    delayedReads < 1 ||
    !sameNote ||
    !sameFile ||
    !sameExecution ||
    hiddenNoteRequests.length ||
    Math.abs(fileScroll - 350) > 2 ||
    errors.length ||
    heaps.some((v) => v.sessionResidents > 6 || v.panelResidents > 8)
  )
    throw Error("panel continuity failed")
} catch (error) {
  console.log("ERRORS", errors, "BODY", (await page.locator("body").innerText()).slice(-5000))
  await page.screenshot({ path: path.join(home, "panels-failure.png") })
  throw error
} finally {
  await browser.close()
}
