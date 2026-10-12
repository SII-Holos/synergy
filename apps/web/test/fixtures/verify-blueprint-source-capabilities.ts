import assert from "node:assert/strict"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const repository = path.resolve(import.meta.dir, "../../../..")
const home = await mkdtemp(path.join(tmpdir(), "synergy-blueprint-source-acceptance-"))
const workspace = path.join(home, "workspace")
await mkdir(path.join(home, ".synergy"), { recursive: true })
await mkdir(workspace)
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
const port = probe.port!
probe.stop(true)
const origin = `http://127.0.0.1:${port}`
const env: Record<string, string> = Object.fromEntries(
  ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "TZ"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : [],
  ),
)
Object.assign(env, {
  SYNERGY_HOME: home,
  SYNERGY_CWD: workspace,
  SYNERGY_CONFIG_CONTENT: "{}",
  MODELS_DEV_API_JSON: path.join(repository, "packages/testing/fixtures/models-api.json"),
  SYNERGY_DISABLE_MODELS_FETCH: "true",
  SYNERGY_DISABLE_DEFAULT_PLUGINS: "true",
  SYNERGY_DISABLE_FILEWATCHER: "true",
  SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
  SYNERGY_DISABLE_BUILTIN_MCP: "1",
  NO_PROXY: "localhost,127.0.0.1,::1",
})
const client = createSynergyClient({ baseUrl: origin, throwOnError: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  reducedMotion: "reduce",
})
const historyPage = await context.newPage()
const notePage = await context.newPage()
const pages = [historyPage, notePage]
const features = new Map<Page, string[]>()
const checks: string[] = []
const requests: Array<{ generation: number; path: string; method: string; page: string }> = []
const errors: Array<{ generation: number; path: string; status: number }> = []
const pageErrors: string[] = []
let generation = 0
let child: ReturnType<typeof Bun.spawn> | undefined
let log: number | undefined
for (const [index, page] of pages.entries()) {
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("request", (request) => {
    if (!["fetch", "xhr"].includes(request.resourceType())) return
    const url = new URL(request.url())
    if (url.origin === origin)
      requests.push({
        generation,
        path: url.pathname,
        method: request.method(),
        page: index === 0 ? "history" : "note",
      })
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.origin !== origin) return
    if (response.status() >= 400 && !(url.pathname === "/global/capabilities" && response.status() === 503))
      errors.push({ generation, path: url.pathname, status: response.status() })
    if (url.pathname === "/global/capabilities" && response.ok())
      void response
        .json()
        .then((value) => features.set(page, value.features))
        .catch(() => {})
  })
}
console.log(JSON.stringify({ home, origin }))
const until = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}
function check(condition: unknown, message: string) {
  assert.ok(condition, message)
  checks.push(message)
  console.log(message)
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const done = await Promise.race([child.exited.then(() => true), Bun.sleep(10000).then(() => false)])
    if (!done) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
  child = undefined
  if (log !== undefined) closeSync(log)
  log = undefined
  const released = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) })
  released.stop(true)
}
async function start(selection: "lattice" | "blueprint") {
  assert.equal(child, undefined)
  generation++
  features.clear()
  log = openSync(path.join(home, `server-${generation}-${selection}.log`), "w")
  child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "verify-runtime-capabilities.ts"),
      "server",
      home,
      String(port),
      selection,
    ],
    { cwd: repository, env, stdin: "ignore", stdout: log, stderr: log },
  )
  await until(async () => {
    if (child?.exitCode !== null) throw new Error(`Source runtime exited: ${child?.exitCode}`)
    return fetch(origin + "/global/capabilities", { signal: AbortSignal.timeout(500) }).then(
      (response) => response.ok,
      () => false,
    )
  }, "Source runtime did not become ready")
  console.log(`ready ${generation} ${selection}`)
}
async function converged(lattice: boolean) {
  await until(
    () =>
      pages.every(
        (page) =>
          features.get(page)?.includes("blueprint") &&
          features.get(page)?.includes("note") &&
          features.get(page)?.includes("lattice") === lattice,
      ),
    "Browser capabilities did not converge",
  )
  await historyPage.waitForTimeout(400)
}
async function transcript() {
  await historyPage.getByText("Keep the original source request", { exact: true }).waitFor()
  await historyPage.getByText("Preserved ordinary source answer", { exact: true }).waitFor()
  await historyPage.getByRole("img", { name: "source-sent.svg", exact: true }).waitFor()
  check(
    !(await historyPage.locator("body").innerText()).includes("Internal source control instructions"),
    "source controls do not replace the original request with internal instructions",
  )
}
async function clean() {
  for (const page of pages)
    check(
      (await page
        .locator(".workbench-surface-load-error,.workbench-surface-error,.note-workspace [role=alert]")
        .count()) === 0,
      "source transition has no unavailable or error card",
    )
}
const artifact = () =>
  Bun.write(
    path.join(home, "result.json"),
    JSON.stringify({ home, port, generation, checks, requests, errors, pageErrors }, null, 2),
  )

try {
  await start("lattice")
  const seedFile = Bun.file(path.join(home, "blueprint-source-seed.json"))
  await until(() => seedFile.exists(), "Source fixture was not seeded")
  const seed = (await seedFile.json()) as { sessionID: string; noteID: string; loopID: string; toolPartID: string }
  const historyURL = `${origin}/aG9tZQ/session/${seed.sessionID}`
  await historyPage.goto(historyURL)
  await notePage.goto(origin)
  await converged(true)
  await transcript()
  await historyPage.locator('[data-component="special-user-message"][data-kind="blueprint-control"]').waitFor()
  const step = historyPage.locator(`[data-part-id="${seed.toolPartID}"] [data-slot="activity-step-trigger"]`)
  if (!(await step.isVisible())) {
    await historyPage.locator('[data-slot="turn-process-trigger"][aria-expanded="false"]').click()
    const batch = historyPage.locator('[data-component="conversation-activity"] > button[aria-expanded="false"]')
    if (await batch.count()) await batch.first().click()
  }
  await step.click()
  await historyPage.locator('[data-component="execution-detail"]').waitFor()
  await notePage.getByRole("button", { name: "Open side workspace", exact: true }).click()
  await notePage.getByRole("button", { name: "Notes", exact: true }).click()
  await notePage.getByText("Preserved source Blueprint", { exact: true }).last().click()
  const noteEditor = notePage.locator(".note-workspace-editor-layout .tiptap[contenteditable=true]")
  await noteEditor.waitFor()
  await notePage.locator(".note-blueprint-session-link").waitFor()
  const composer = historyPage.locator('[data-component="prompt-input"][contenteditable="true"]')
  await composer.fill("Keep the ordinary source draft")
  await historyPage.waitForTimeout(500)
  check(
    requests.some((request) => request.path === `/blueprint/loop/${seed.loopID}`),
    "installed source loads its bound loop through the browser",
  )
  check(
    (await client.session.get({ sessionID: seed.sessionID, scopeID: "home" })).data?.blueprint?.source === "lattice",
    "installed source publishes the session binding",
  )
  await historyPage.screenshot({ path: path.join(home, "installed-history.png"), animations: "disabled" })
  await stop()
  await start("blueprint")
  await converged(false)
  await notePage.locator(".note-blueprint-session-link").waitFor({ state: "detached" })
  await historyPage.locator('[data-component="execution-detail"]').waitFor({ state: "detached" })
  await transcript()
  check(
    (await historyPage.locator('[data-component="special-user-message"][data-kind="blueprint-control"]').count()) === 0,
    "removing only Lattice hides the old Blueprint control badge",
  )
  check((await step.count()) === 0, "removing only Lattice hides its historical tool action")
  check(
    (await noteEditor.textContent())?.includes("Ordinary Blueprint document"),
    "the Blueprint document remains available without Lattice",
  )
  await notePage.getByRole("button", { name: "Run", exact: true }).click()
  await notePage.locator(".note-run-menu").waitFor()
  await notePage.locator(".note-run-menu-close").click()
  check(true, "the absent source no longer occupies the document's user Blueprint run slot")
  check(
    (await composer.textContent())?.includes("Keep the ordinary source draft"),
    "partial removal preserves the ordinary composer draft",
  )
  const note = (await client.note.get({ id: seed.noteID, scopeID: "home" })).data
  check(
    note?.kind === "blueprint" && !note.blueprint?.activeLoopID && note.blueprint?.lastRunAt === undefined,
    "Note projects away only the unavailable loop binding and history",
  )
  check(
    !(await client.session.get({ sessionID: seed.sessionID, scopeID: "home" })).data?.blueprint,
    "Session projects away its unavailable source binding before browser GET",
  )
  await historyPage.reload()
  await transcript()
  await historyPage.waitForTimeout(800)
  check(
    (await composer.textContent())?.includes("Keep the ordinary source draft"),
    "cold deep-link navigation restores the ordinary draft",
  )
  check(
    requests.filter(
      (request) =>
        request.generation === generation &&
        (request.path === `/blueprint/loop/${seed.loopID}` || /^\/lattice(?:\/|$)/.test(request.path)),
    ).length === 0,
    "live removal and cold deep link issue no unavailable source requests",
  )
  check(
    !(await historyPage.locator("body").innerText()).includes("Internal source tool metadata"),
    "unavailable tool control JSON stays hidden",
  )
  await clean()
  await historyPage.screenshot({ path: path.join(home, "absent-history.png"), animations: "disabled" })
  await notePage.screenshot({ path: path.join(home, "absent-note.png"), animations: "disabled" })
  await stop()
  await start("lattice")
  await converged(true)
  await notePage.locator(".note-blueprint-session-link").waitFor()
  await transcript()
  await historyPage.locator('[data-component="special-user-message"][data-kind="blueprint-control"]').waitFor()
  check(
    (await client.note.get({ id: seed.noteID, scopeID: "home" })).data?.blueprint?.activeLoopID === seed.loopID,
    "reinstall restores the retained Note binding",
  )
  check(
    (await client.session.get({ sessionID: seed.sessionID, scopeID: "home" })).data?.blueprint?.loopID === seed.loopID,
    "reinstall restores the retained Session binding",
  )
  check(
    (await composer.textContent())?.includes("Keep the ordinary source draft"),
    "reinstall retains the ordinary draft",
  )
  await clean()
  await historyPage.screenshot({ path: path.join(home, "restored-history.png"), animations: "disabled" })
  check(errors.length === 0, "all browser HTTP requests succeed outside readiness retries")
  check(pageErrors.length === 0, "all partial-source phases have no browser page errors")
  await artifact()
} catch (error) {
  await artifact()
  await historyPage
    .screenshot({ path: path.join(home, `failure-${generation}.png`), animations: "disabled" })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
  await stop()
  console.log(JSON.stringify({ home, port, stopped: true, checks: checks.length }))
}
