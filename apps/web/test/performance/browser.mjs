import path from "node:path"
import os from "node:os"
const [repo, home] = process.argv.slice(2),
  { chromium } = await import(path.join(repo, "apps/web/node_modules/playwright/index.mjs")),
  manifest = await Bun.file(path.join(home, "manifest.json")).json(),
  browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1728, height: 1080 } }),
  errors = []
let collecting = false,
  categories = {},
  requests = {}
const contentRequests = []
const seenContent = new Set()
const pendingReads = new Set()
let readsChangedAt = Date.now()
let navigationIndex = -1
page.on("pageerror", (error) => errors.push(error.message))
page.on("request", (request) => {
  const contentPath = new URL(request.url()).pathname
  if (contentPath.startsWith("/session/")) {
    pendingReads.add(request)
    readsChangedAt = Date.now()
  }
  const repeated = seenContent.has(contentPath)
  if (contentPath.endsWith("/content")) seenContent.add(contentPath)
  if (!collecting) return
  const name = new URL(request.url()).pathname
    .replace(/ses_[^/]+/g, ":session")
    .replace(/msg_[^/]+/g, ":message")
    .replace(/prt_[^/]+/g, ":part")
  requests[name] = (requests[name] ?? 0) + 1
  if (name.endsWith("/content"))
    contentRequests.push({
      session: manifest.sessions.findIndex((session) => request.url().includes(session.id)),
      time: Date.now(),
      repeated,
      navigationIndex,
    })
})
const finishRead = (request) => {
  if (pendingReads.delete(request)) readsChangedAt = Date.now()
}
page.on("requestfinished", finishRead)
page.on("requestfailed", finishRead)
const settleWarmup = async () => {
  const deadline = Date.now() + 120000
  readsChangedAt = Date.now()
  while (pendingReads.size || Date.now() - readsChangedAt < 500) {
    if (Date.now() > deadline) throw Error("Warm-up Session reads did not settle")
    await page.waitForTimeout(50)
  }
}
page.on("websocket", (socket) =>
  socket.on("framereceived", (frame) => {
    if (!collecting) return
    const data = String(frame.payload)
    let type = "unknown"
    try {
      type = JSON.parse(data).payload?.type ?? "control"
    } catch {}
    const count = (categories[type] ??= { frames: 0, bytes: 0 })
    count.frames++
    count.bytes += Buffer.byteLength(data)
  }),
)
await page.addInitScript(() => {
  window.__perf = { longTasks: [], marks: [], mounts: 0 }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: "longtask", buffered: true })
})
try {
  await page.goto(manifest.origin + manifest.sessions[2].route, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.waitForSelector("[data-conversation-viewport]", { timeout: 120000 })
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-component="text-part"]')].some(
        (e) => e.checkVisibility({ visibilityProperty: true }) && !e.closest('[inert], [aria-hidden="true"]'),
      ),
    { timeout: 120000 },
  )
  await page.screenshot({ path: path.join(home, "initial.png") })
  console.log("BOOT_READY")
  const targets = [manifest.sessions[0], manifest.sessions[3], manifest.sessions[4]],
    nav = async (target) => {
      const start = await page.evaluate((route) => {
        const link = document.createElement("a")
        link.href = route
        link.textContent = "Benchmark navigation"
        document.body.append(link)
        const start = performance.now()
        link.click()
        link.remove()
        return start
      }, target.route)
      await page.waitForFunction(
        ({ route, index }) =>
          location.pathname === route &&
          [...document.querySelectorAll('[data-component="text-part"]')].some(
            (e) =>
              e.checkVisibility({ visibilityProperty: true }) &&
              !e.closest('[inert], [aria-hidden="true"]') &&
              e.textContent?.includes(`Fixture ${index} message`),
          ),
        { route: target.route, index: Number(target.title.split(" ").at(-1)) },
        { timeout: 120000 },
      )
      return page.evaluate((start) => performance.now() - start, start)
    }
  for (const target of targets) {
    await nav(target)
    await settleWarmup()
  }
  const navigation = []
  collecting = true
  for (let i = 0; i < 30; i++) {
    navigationIndex = i
    navigation.push(await nav(targets[i % targets.length]))
  }
  collecting = false
  const hotRequests = requests
  requests = {}
  const hotWebsocket = categories
  categories = {}
  await nav(manifest.sessions[0])
  await page.waitForTimeout(1200)
  console.log("CLIENT_READY_FOR_BURST")
  await Bun.write(path.join(home, "client-ready"), "ready")
  collecting = true
  const log = path.join(home, "burst-done"),
    deadline = Date.now() + 120000
  while (!(await Bun.file(log).exists())) {
    if (Date.now() > deadline) throw Error("burst timed out")
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1500)
  collecting = false
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-component="text-part"]')].some(
        (e) =>
          e.checkVisibility({ visibilityProperty: true }) &&
          !e.closest('[inert], [aria-hidden="true"]') &&
          e.textContent?.includes("chunk 299:"),
      ),
    void 0,
    { timeout: 1e4 },
  )
  const streamValidation = []
  for (const index of [0, 1]) {
    if (index) await nav(manifest.sessions[index])
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-component="text-part"]')].some(
        (element) =>
          element.checkVisibility({ visibilityProperty: true }) &&
          !element.closest('[inert], [aria-hidden="true"]') &&
          element.textContent?.includes("chunk 299:"),
      ),
    )
    const read = new Set()
    let windows = 0
    for (; windows < 512; windows++) {
      const chunks = (await page.locator('[data-component="text-part"]:visible').allTextContents()).flatMap((value) =>
        [...value.matchAll(/chunk (\d+):/g)].map((match) => Number(match[1])),
      )
      if (chunks.some((chunk, offset) => offset > 0 && chunk !== chunks[offset - 1] + 1))
        throw Error(`Rendered stream has an out-of-order window in session ${index}`)
      chunks.forEach((chunk) => read.add(chunk))
      if (read.size === 300) break
      await page.locator("[data-conversation-viewport]:visible").evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight * 0.75)
      })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const chunks = [...read].sort((a, b) => a - b)
    if (chunks.length !== 300 || chunks.some((chunk, offset) => chunk !== offset))
      throw Error(`Rendered stream differs from the complete fixture: session ${index}, ${chunks.length} chunks`)
    streamValidation.push({ session: index, chunks: chunks.length, ordered: true, windows: windows + 1 })
  }
  await settleWarmup()
  await page.locator('[data-conversation-viewport][data-ready="true"]:visible').waitFor()
  const prompt = page.locator('[data-component="prompt-input"]:visible')
  await prompt.fill("Verified editable after concurrent streams")
  if ((await prompt.inputValue().catch(() => prompt.innerText())) !== "Verified editable after concurrent streams")
    throw Error("Composer did not retain its draft")
  const performance = await page.evaluate(() => window.__perf),
    visible = await page.locator('[data-component="text-part"]:visible').allTextContents(),
    report = {
      version: path.basename(home),
      runtime: {
        bun: Bun.version,
        browser: browser.version(),
        platform: os.platform(),
        architecture: os.arch(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        viewport: { width: 1728, height: 1080 },
      },
      navigationMs: navigation,
      p95: navigation.toSorted((a, b) => a - b)[Math.ceil(navigation.length * 0.95) - 1],
      hotRequests,
      contentRequests,
      hotWebsocket,
      streamRequests: requests,
      websocket: categories,
      performance,
      errors,
      visibleCharacters: visible.join("").length,
      residents: await page.locator("[data-session-resident]").count(),
      streamValidation,
      composerEditable: true,
    }
  await Bun.write(path.join(home, "report.json"), JSON.stringify(report, null, 2))
  await page.screenshot({ path: path.join(home, "final.png") })
  console.log(
    JSON.stringify(
      { p95: report.p95, errors, wsBytes: Object.values(categories).reduce((a, c) => a + c.bytes, 0), hotRequests },
      null,
      2,
    ),
  )
} catch (error) {
  await page.screenshot({ path: path.join(home, "failure.png") }).catch(() => {})
  console.error("URL", page.url(), "ERRORS", errors)
  console.error((await page.locator("body").innerText()).slice(0, 6000))
  throw error
} finally {
  await browser.close()
}
