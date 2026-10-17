import path from "node:path"
const [repo, home] = process.argv.slice(2)
const { chromium } = await import(path.join(repo, "apps/web/node_modules/playwright/index.mjs"))
const manifest = await Bun.file(path.join(home, "execution-manifest.json")).json()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1728, height: 1080 } })
const errors = [],
  httpErrors = [],
  navigation = [],
  input = [],
  events = {}
page.on("pageerror", (error) => errors.push(error.message))
page.on("response", (response) => {
  const route = new URL(response.url()).pathname
  if (response.status() >= 500 && route.includes("/execution/"))
    httpErrors.push({ route: route.replace(/ses_[^/]+/g, ":session"), status: response.status() })
})
page.on("websocket", (socket) =>
  socket.on("framereceived", (frame) => {
    try {
      const type = JSON.parse(String(frame.payload)).payload?.type
      if (type?.startsWith("cortex.")) events[type] = (events[type] ?? 0) + 1
    } catch {}
  }),
)
await page.addInitScript(() => {
  document.addEventListener("beforeinput", (event) => {
    if (!event.target.closest?.('[data-component="prompt-input"]')) return
    requestAnimationFrame(() => (window.__fixtureInput = performance.now() - event.timeStamp))
  })
})
const percentile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null
try {
  await page.goto(manifest.origin + manifest.sessions[0].route, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.locator('[data-component="prompt-input"]:visible').waitFor({ timeout: 120000 })
  await Bun.write(path.join(home, "execution-browser-ready"), "ready")
  const drafts = new Set(),
    seen = []
  const started = Date.now()
  let iteration = 0
  let executionNode, executionOpenMs
  while (Date.now() - started < 300000) {
    const target =
      manifest.sessions[
        iteration % 10 === 9 ? (Math.floor(iteration / 10) + 3) % manifest.sessions.length : iteration % 3
      ]
    const warm = seen.slice(-6).includes(target.id)
    const start = await page.evaluate((route) => {
      const link = document.createElement("a")
      link.href = route
      document.body.append(link)
      const started = performance.now()
      link.click()
      link.remove()
      return started
    }, target.route)
    await page.waitForFunction(
      (target) => {
        const owner = [...document.querySelectorAll("[data-session-resident]")].find(
          (el) => !el.hidden && JSON.parse(el.getAttribute("data-session-resident")).sessionID === target.id,
        )
        return (
          location.pathname === target.route &&
          owner &&
          [...owner.querySelectorAll('[data-component="text-part"]')].some(
            (el) => el.getBoundingClientRect().height > 0 && el.textContent.trim(),
          ) &&
          [...owner.querySelectorAll('[data-component="prompt-input"]')].some(
            (el) => el.getBoundingClientRect().height > 0 && el.getAttribute("contenteditable") === "true",
          )
        )
      },
      target,
      { timeout: 60000 },
    )
    navigation.push({ warm, duration: await page.evaluate((start) => performance.now() - start, start) })
    const prior = seen.indexOf(target.id)
    if (prior >= 0) seen.splice(prior, 1)
    seen.push(target.id)
    const prompt = page.locator('[data-component="prompt-input"]:visible')
    const draft = `Execution draft ${target.id}`
    if (drafts.has(target.id) && (await prompt.innerText()) !== draft) throw Error("Execution draft ownership changed")
    await page.evaluate(() => (window.__fixtureInput = undefined))
    await prompt.fill(draft)
    await page.waitForFunction(() => Number.isFinite(window.__fixtureInput))
    input.push(await page.evaluate(() => window.__fixtureInput))
    drafts.add(target.id)
    if (!iteration) {
      const opened = performance.now()
      await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
      const side = page.locator(".workbench-surface--side:visible")
      await side
        .getByRole("button", { name: /^Task details/ })
        .first()
        .click()
      await side.locator(".context-activity .context-section-heading button").click()
      const execution = side.locator(".execution-panel")
      await execution.locator(".execution-search input").fill("Fixture")
      executionNode = await execution.elementHandle()
      executionOpenMs = performance.now() - opened
    }
    iteration++
    if (Date.now() - started > 30000 && (await Bun.file(path.join(home, "execution-browser-stop")).exists())) break
    await page.waitForTimeout(250)
  }
  const warm = navigation.filter((row) => row.warm).map((row) => row.duration)
  const cold = navigation.filter((row) => !row.warm).map((row) => row.duration)
  const residents = await page.locator("[data-session-resident]").count()
  const report = {
    elapsedMs: Date.now() - started,
    switches: navigation.length,
    warm: { p95: percentile(warm, 0.95), p99: percentile(warm, 0.99) },
    cold: { p95: percentile(cold, 0.95) },
    input: { p95: percentile(input, 0.95) },
    residents,
    executionOpenMs,
    executionRetained: await executionNode.evaluate(
      (element) => element.isConnected && element.querySelector(".execution-search input")?.value === "Fixture",
    ),
    navigation,
    events,
    httpErrors,
    errors,
  }
  await Bun.write(path.join(home, "execution-browser.json"), JSON.stringify(report, null, 2))
  await page.screenshot({ path: path.join(home, "execution-browser.png") })
  if (errors.length || httpErrors.length || residents > 6 || !report.executionRetained)
    throw Error("Execution browser acceptance failed")
} catch (error) {
  await Bun.write(
    path.join(home, "execution-browser-failure.json"),
    JSON.stringify({ error: String(error), errors, httpErrors, navigation, events }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
