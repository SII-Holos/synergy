import path from "node:path"
const [repo, home] = process.argv.slice(2)
const { chromium } = await import(path.join(repo, "apps/web/node_modules/playwright/index.mjs"))
const manifest = await Bun.file(path.join(home, "manifest.json")).json()
const browser = await chromium.launch({ headless: true, args: ["--js-flags=--expose-gc"] })
const page = await browser.newPage({ viewport: { width: 1728, height: 1080 } })
const errors = [],
  navigation = [],
  input = [],
  heaps = [],
  requests = {},
  events = {}
let collected = false,
  targetID
page.on("pageerror", (error) => errors.push(error.message))
page.on("request", (request) => {
  if (!collected) return
  const route = new URL(request.url()).pathname
    .replace(/ses_[^/]+/g, ":session")
    .replace(/msg_[^/]+/g, ":message")
    .replace(/prt_[^/]+/g, ":part")
  requests[route] = (requests[route] ?? 0) + 1
})
page.on("websocket", (socket) =>
  socket.on("framereceived", (frame) => {
    if (!collected) return
    const payload = String(frame.payload)
    let name = "control"
    try {
      name = JSON.parse(payload).payload?.type ?? name
    } catch {}
    const row = (events[name] ??= { frames: 0, bytes: 0 })
    row.frames++
    row.bytes += Buffer.byteLength(payload)
  }),
)
await page.addInitScript(() => {
  window.__load = { sockets: [], longTasks: 0, longTaskMs: 0 }
  document.addEventListener("beforeinput", (event) => {
    if (!event.target.closest?.('[data-component="prompt-input"]')) return
    const start = event.timeStamp
    requestAnimationFrame(() => {
      window.__load.inputMs = performance.now() - start
    })
  })
  const Socket = WebSocket
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args)
      window.__load.sockets.push(this)
    }
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__load.longTasks++
      window.__load.longTaskMs += entry.duration
    }
  }).observe({ type: "longtask", buffered: true })
})
const percentile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null
try {
  await page.goto(manifest.origin + manifest.sessions[0].route, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.locator('[data-component="prompt-input"]:visible').waitFor({ timeout: 120000 })
  const seen = []
  const drafts = new Set()
  const navigate = async (target) => {
    targetID = target.id
    const index = Number(target.title.split(" ").at(-1))
    const warm = seen.slice(-6).includes(target.id)
    const started = await page.evaluate((route) => {
      const a = document.createElement("a")
      a.href = route
      document.body.append(a)
      const start = performance.now()
      a.click()
      a.remove()
      return start
    }, target.route)
    await page.waitForFunction(
      ({ route, index }) =>
        location.pathname === route &&
        [...document.querySelectorAll('[data-component="text-part"]')].some(
          (node) =>
            node.getBoundingClientRect().height > 0 &&
            (node.textContent.includes(`Fixture ${index} message`) ||
              node.textContent.includes(`Fixture ${index} chunk`)),
        ) &&
        [...document.querySelectorAll('[data-component="prompt-input"]')].some(
          (node) => node.getBoundingClientRect().height > 0 && node.getAttribute("contenteditable") === "true",
        ),
      { route: target.route, index },
      { timeout: 30000 },
    )
    const duration = await page.evaluate((start) => performance.now() - start, started)
    const previous = seen.indexOf(target.id)
    if (previous >= 0) seen.splice(previous, 1)
    seen.push(target.id)
    const prompt = page.locator('[data-component="prompt-input"]:visible')
    if (drafts.has(target.id) && !(await prompt.innerText()).includes(`Draft ${index}`))
      throw Error("Session draft was lost")
    await page.evaluate(() => {
      window.__load.inputMs = undefined
    })
    await prompt.fill(`Draft ${index}`)
    await page.waitForFunction(() => Number.isFinite(window.__load.inputMs))
    const inputDuration = await page.evaluate(() => window.__load.inputMs)
    drafts.add(target.id)
    if (collected) {
      navigation.push({ warm, duration })
      input.push(inputDuration)
    }
  }
  for (const target of manifest.sessions.slice(0, 3)) await navigate(target)
  collected = true
  console.log("CLIENT_READY_FOR_BURST")
  const started = Date.now(),
    cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  let iteration = 0,
    nextSample = 0
  while (Date.now() - started < manifest.durationMs) {
    const target =
      iteration % 10 === 9
        ? manifest.sessions[(Math.floor(iteration / 10) + 3) % manifest.sessions.length]
        : manifest.sessions[iteration % 3]
    await navigate(target)
    if (Date.now() - started >= nextSample) {
      await cdp.send("HeapProfiler.collectGarbage")
      const metrics = await cdp.send("Performance.getMetrics")
      heaps.push({
        elapsedMs: Date.now() - started,
        heap: metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value,
        sessions: await page.locator("[data-session-resident]").count(),
        panels: await page.locator("[data-resident-panel]").count(),
      })
      if (heaps.at(-1).sessions > 6 || heaps.at(-1).panels > 8) throw Error("Residency budget exceeded")
      await Bun.write(
        path.join(home, "soak-progress.json"),
        JSON.stringify({ iteration, elapsedMs: Date.now() - started, lastHeap: heaps.at(-1), errors }),
      )
      nextSample += 60000
      console.log(`SOAK_PROGRESS ${Math.round((Date.now() - started) / 1000)}s ${iteration} switches`)
    }
    if (iteration && iteration % 120 === 0)
      await page.evaluate(() => {
        for (const socket of window.__load.sockets) if (socket.readyState === 1) socket.close(1000, "Fixture reconnect")
      })
    iteration++
    await page.waitForTimeout(500)
  }
  const metrics = await page.evaluate(() => ({
    longTasks: window.__load.longTasks,
    longTaskMs: window.__load.longTaskMs,
  }))
  const warm = navigation.filter((item) => item.warm).map((item) => item.duration)
  const cold = navigation.filter((item) => !item.warm).map((item) => item.duration)
  const report = {
    streamCount: manifest.streamCount,
    elapsedMs: Date.now() - started,
    switches: navigation.length,
    warm: { p95: percentile(warm, 0.95), p99: percentile(warm, 0.99) },
    cold: { p95: percentile(cold, 0.95) },
    input: { p95: percentile(input, 0.95) },
    navigation,
    heaps,
    requests,
    events,
    metrics,
    errors,
  }
  await Bun.write(path.join(home, "soak-report.json"), JSON.stringify(report, null, 2))
  await Bun.write(path.join(home, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, navigation: undefined, requests: undefined, events: undefined }))
  if (errors.length) throw Error("Browser errors during pressure fixture")
} catch (error) {
  await Bun.write(
    path.join(home, "soak-failure.json"),
    JSON.stringify({ targetID, error: String(error), navigation, heaps, errors, requests, events }, null, 2),
  )
  await page.screenshot({ path: path.join(home, "soak-failure.png") }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
