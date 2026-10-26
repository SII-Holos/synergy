import assert from "node:assert/strict"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const repository = path.resolve(import.meta.dir, "../../../..")
const compositions = ["core", "library", "agenda", "light-loop", "email", "channels", "blueprint", "workbench", "full"]
const requested = process.argv.slice(2)
for (const selection of requested) assert.ok(compositions.includes(selection), `Unknown composition: ${selection}`)
const selections = requested.length ? requested : compositions
const home = await mkdtemp(path.join(tmpdir(), "synergy-web-composition-matrix-"))
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
const navigation = [
  ["Agenda", "agenda", "/agenda"],
  ["Kanban", "kanban", "/kanban"],
  ["Library", "library", "/library"],
  ["Performance", "workbench", "/performance"],
  ["Plugins", "plugin-host", "/plugins/marketplace"],
] as const
const settings = [
  ["Voice", "media"],
  ["GitHub", "github"],
  ["Learning", "library"],
  ["Memory", "library"],
  ["Experience", "library"],
  ["MCP", "mcp"],
  ["Channels", "channels"],
  ["Email", "email"],
  ["Boss Mode", "boss"],
] as const
const workflows = [
  ["Light Loop", "light-loop"],
  ["Plan", "blueprint"],
  ["Lattice", "lattice"],
  ["Boss", "boss"],
] as const
const routeOwners: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/note(?:\/|$)/, "note"],
  [/^\/library(?:\/|$)/, "library"],
  [/^\/(?:global\/)?agenda(?:\/|$)/, "agenda"],
  [/^\/blueprint(?:\/|$)/, "blueprint"],
  [/^\/lattice(?:\/|$)/, "lattice"],
  [/^\/boss(?:\/|$)/, "boss"],
  [/^\/anima(?:\/|$)/, "anima"],
  [/^\/channel(?:\/|$)/, "channels"],
  [/^\/email(?:\/|$)/, "email"],
  [/^\/(?:provider\/auth\/)?github(?:\/|$)/, "github"],
  [/^\/(?:plugin|api\/(?:plugins|registry))(?:\/|$)/, "plugin-host"],
  [/^\/mcp(?:\/|$)/, "mcp"],
  [/^\/lsp(?:\/|$)/, "lsp"],
  [/^\/formatter(?:\/|$)/, "formatter"],
  [/^(?:\/[^/]+)?\/browser(?:\/|$)/, "browser"],
  [/^\/computer(?:\/|$)/, "computer"],
  [/^\/voice(?:\/|$)/, "media"],
  [/^\/(?:global\/(?:project|git|stats|performance)|review|vcs|push)(?:\/|$)/, "workbench"],
  [/^\/workflow\/.*lightloop(?:\/|$)/, "light-loop"],
]
type Request = { selection: string; phase: string; path: string; method: string; owner?: string }
const requests: Request[] = []
const responses: Array<{ selection: string; phase: string; path: string; status: number }> = []
const successfulResponses: Array<{ selection: string; phase: string; path: string }> = []
const results: Array<{ selection: string; features: string[]; checks: string[]; requests: number }> = []
const pageErrors: string[] = []
let selection = "core"
let phase = "bootstrap"
let child: ReturnType<typeof Bun.spawn> | undefined
let log: number | undefined
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  reducedMotion: "reduce",
})
page.setDefaultTimeout(15000)
page.on("pageerror", (error) => pageErrors.push(`${selection}/${phase}: ${error.stack ?? error.message}`))
page.on("request", (request) => {
  if (!["fetch", "xhr"].includes(request.resourceType())) return
  const url = new URL(request.url())
  if (url.origin !== origin) return
  requests.push({
    selection,
    phase,
    path: url.pathname,
    method: request.method(),
    owner: routeOwners.find(([pattern]) => pattern.test(url.pathname))?.[1],
  })
})
page.on("response", (response) => {
  if (!["fetch", "xhr"].includes(response.request().resourceType())) return
  if (response.ok()) successfulResponses.push({ selection, phase, path: new URL(response.url()).pathname })
  if (response.status() < 400) return
  responses.push({ selection, phase, path: new URL(response.url()).pathname, status: response.status() })
})

async function until(test: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await test()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10000).then(() => false)])
    if (!exited) {
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
async function start() {
  assert.equal(child, undefined)
  log = openSync(path.join(home, `server-${selection}.log`), "w")
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
  let features: string[] = []
  await until(async () => {
    if (child?.exitCode !== null) throw new Error(`Server ${selection} exited: ${child?.exitCode}`)
    try {
      const response = await fetch(origin + "/global/capabilities", { signal: AbortSignal.timeout(500) })
      if (!response.ok) return false
      features = (await response.json()).features
      return true
    } catch {
      return false
    }
  }, `Server ${selection} did not become ready`)
  return features
}
async function cleanSurface() {
  assert.equal(
    await page
      .locator(
        ".workbench-surface-load-error,.workbench-surface-error,.settings-resource-error,.library-home [role=alert],.performance-workbench [role=alert],.note-workspace [role=alert],.plugin-marketplace [role=alert]",
      )
      .count(),
    0,
    `${selection}/${phase}: error card`,
  )
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
}
async function loadedRequests(paths: readonly string[], since: number) {
  await until(
    () => paths.every((path) => successfulResponses.slice(since).some((response) => response.path === path)),
    `${selection}/${phase}: expected successful browser reads ${paths.join(", ")}`,
  )
}
async function loadedPage(route: string, since: number) {
  await page.waitForFunction(() => document.getElementById("synergy-app-boot") === null)
  if (route === "/agenda") {
    await page.getByRole("textbox", { name: "Search tasks", exact: true }).waitFor()
    await loadedRequests(["/global/agenda"], since)
  }
  if (route === "/kanban") await page.locator('[data-component="kanban-panel"]').waitFor()
  if (route === "/library") {
    await page.getByRole("textbox", { name: "Search library", exact: true }).waitFor()
    await loadedRequests(["/library/stats"], since)
    await page.getByText("Loading library…", { exact: true }).waitFor({ state: "hidden" })
  }
  if (route === "/performance") {
    await page.getByRole("region", { name: "Resource usage", exact: true }).waitFor()
    await loadedRequests(["/global/performance/summary"], since)
  }
  if (route === "/plugins/marketplace") {
    await page.getByRole("textbox", { name: "Search plugins", exact: true }).waitFor()
    await loadedRequests(["/api/plugins", "/api/registry/search"], since)
  }
}
async function visibleFeatures(
  entries: ReadonlyArray<readonly [string, string, ...string[]]>,
  features: string[],
  checks: string[],
  container = page.locator("body"),
) {
  for (const [label, owner] of entries) {
    const found = (await container.getByRole("button", { name: label, exact: true }).count()) > 0
    assert.equal(found, features.includes(owner), `${selection}/${phase}: ${label}`)
  }
  checks.push(`${phase}: feature entrypoints match capabilities`)
}
async function inspectWorkflows(features: string[], checks: string[]) {
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await until(async () => {
    if (!(await page.locator(".prompt-add-menu").count()))
      await page.getByRole("button", { name: "Add", exact: true }).click()
    for (const [label, owner] of workflows) {
      const found = (await page.locator(".prompt-add-menu").getByText(label, { exact: true }).count()) > 0
      if (found !== features.includes(owner)) return false
    }
    return true
  }, `${selection}/${phase}: workflow menu did not converge with capabilities`)
  for (const [label, owner] of workflows) {
    const found = (await page.locator(".prompt-add-menu").getByText(label, { exact: true }).count()) > 0
    assert.equal(found, features.includes(owner), `${selection}/${phase}: workflow ${label}`)
  }
  await page.keyboard.press("Escape")
  checks.push(`${phase}: workflow choices match capabilities`)
}

console.log(JSON.stringify({ home, origin }))
try {
  for (selection of selections) {
    phase = "bootstrap"
    const features = await start()
    const checks: string[] = []
    if (selection !== "full")
      assert.deepEqual(
        features.toSorted(),
        (selection === "core" ? [] : selection === "blueprint" ? ["blueprint", "note"] : [selection]).toSorted(),
      )
    console.log(JSON.stringify({ selection, features }))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(origin + "/aG9tZQ/session")
    await page.waitForFunction(() => document.getElementById("synergy-app-boot") === null)
    await page.getByRole("button", { name: "Add", exact: true }).waitFor()
    phase = "desktop"
    await visibleFeatures(navigation, features, checks, page.locator(".sb-globals"))
    await inspectWorkflows(features, checks)
    await page.screenshot({ path: path.join(home, `${selection}-desktop.png`), animations: "disabled" })
    phase = "settings-desktop"
    await page.getByRole("button", { name: /当前空间|Current space/ }).click()
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
    await page.getByRole("button", { name: "Close settings", exact: true }).waitFor()
    await visibleFeatures(settings, features, checks, page.locator(".settings-panel-navigation"))
    await page
      .locator(".settings-panel-navigation")
      .getByRole("button", { name: "Experimental features", exact: true })
      .waitFor()
    for (const [label, owner] of settings) {
      if (!features.includes(owner)) continue
      await page.locator(".settings-panel-navigation").getByRole("button", { name: label, exact: true }).click()
      await until(
        async () => (await page.locator(".settings-panel-loading").count()) === 0,
        `${label} settings did not load`,
      )
      await cleanSurface()
    }
    phase = "settings-mobile"
    await page.setViewportSize({ width: 375, height: 812 })
    await page.locator(".settings-panel-content").waitFor({ state: "hidden" })
    await page.locator(".settings-panel-navigation").waitFor()
    await visibleFeatures(settings, features, checks, page.locator(".settings-panel-navigation"))
    await page.screenshot({ path: path.join(home, `${selection}-settings-mobile.png`), animations: "disabled" })
    await page.getByRole("button", { name: "Close settings", exact: true }).click()
    phase = "mobile"
    await inspectWorkflows(features, checks)
    await page.getByRole("button", { name: "Open tools", exact: true }).click()
    await visibleFeatures(navigation, features, checks, page.getByRole("dialog", { name: "Tools", exact: true }))
    await page.screenshot({ path: path.join(home, `${selection}-mobile.png`), animations: "disabled" })
    await page.getByRole("button", { name: "Close tools", exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 1000 })
    phase = "resources"
    await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
    await page.locator(".resource-home").waitFor()
    await visibleFeatures(
      [
        ["Notes", "note"],
        ["Browser", "browser"],
      ],
      features,
      checks,
      page.locator(".resource-home"),
    )
    if (features.includes("note")) {
      const since = successfulResponses.length
      await page.getByRole("button", { name: "Notes", exact: true }).click()
      await page.getByRole("searchbox", { name: "Search notes...", exact: true }).waitFor()
      await loadedRequests(["/note/meta"], since)
      await cleanSurface()
      checks.push("resources: selected Note list loaded through browser API")
    }
    await page.screenshot({ path: path.join(home, `${selection}-resources.png`), animations: "disabled" })
    phase = "deep-links"
    for (const [, owner, route] of navigation) {
      const since = successfulResponses.length
      const document = await page.goto(origin + route)
      assert.match(document?.headers()["content-type"] ?? "", /text\/html/, `${selection}: ${route} document`)
      if (!features.includes(owner)) await page.waitForURL(origin + "/aG9tZQ/session")
      else {
        await page.waitForURL(origin + route)
        await loadedPage(route, since)
        await page.screenshot({
          path: path.join(home, `${selection}-page-${route.split("/").at(-1)}.png`),
          animations: "disabled",
        })
      }
      await cleanSurface()
    }
    checks.push("deep-links: absent routes redirect and selected routes load")
    await page.goto(origin + "/aG9tZQ/session")
    await page.getByRole("button", { name: "Add", exact: true }).waitFor()
    await page.waitForTimeout(350)
    const selectedRequests = requests.filter((request) => request.selection === selection)
    const absentRequests = selectedRequests.filter((request) => request.owner && !features.includes(request.owner))
    assert.deepEqual(absentRequests, [], `${selection}: missing owner requests`)
    assert.deepEqual(
      responses.filter((response) => response.selection === selection && response.status !== 503),
      [],
      `${selection}: failed API responses`,
    )
    checks.push("network: no absent-owner requests or failing APIs")
    await cleanSurface()
    checks.push("render: no unavailable/error cards or page errors")
    results.push({ selection, features, checks, requests: selectedRequests.length })
    await Bun.write(
      path.join(home, "result.json"),
      JSON.stringify({ results, requests, responses, successfulResponses, pageErrors }, null, 2),
    )
    console.log(JSON.stringify({ selection, passed: checks.length, requests: selectedRequests.length }))
    if (selection === "full") {
      phase = "experimental-restart"
      const client = createSynergyClient({ baseUrl: origin })
      await client.config.domain.update(
        {
          domain: "features",
          configDomainUpdateInput: { config: { features: { optIn: ["uninstalled-fixture"] } }, mode: "replace-domain" },
        },
        { throwOnError: true },
      )
      const openExperiments = async (loaded = true) => {
        await page.getByRole("button", { name: /当前空间|Current space/ }).click()
        await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
        await page
          .locator(".settings-panel-navigation")
          .getByRole("button", { name: "Experimental features", exact: true })
          .click()
        if (loaded) await page.getByRole("switch", { name: "Boss mode", exact: true }).waitFor()
      }
      await page.route(
        "**/global/features",
        (route) => route.fulfill({ status: 500, body: "private fixture diagnostic" }),
        { times: 1 },
      )
      await openExperiments(false)
      await page.getByRole("alert").filter({ hasText: "Couldn't load experimental features." }).waitFor()
      assert.equal(await page.getByText("Loading…", { exact: true }).count(), 0)
      assert.equal(await page.getByText("private fixture diagnostic", { exact: false }).count(), 0)
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await page.getByRole("switch", { name: "Boss mode", exact: true }).waitFor()
      const retained = page.getByRole("switch", { name: "uninstalled-fixture", exact: true })
      assert.equal(await retained.isChecked(), true)
      await retained.press("Space")
      assert.equal(await retained.isDisabled(), false, "Retained choices must allow undo before saving")
      await retained.press("Space")
      assert.equal(await retained.isChecked(), true)
      await retained.press("Space")
      for (const name of ["Boss mode", "Lattice", "Kanban"]) {
        const toggle = page.getByRole("switch", { name, exact: true })
        assert.equal(await toggle.isChecked(), false)
        await toggle.press("Space")
        assert.equal(await toggle.isChecked(), true)
      }
      await page.route(
        "**/config/domains/features",
        (route) => route.fulfill({ status: 500, body: "private fixture diagnostic" }),
        { times: 1 },
      )
      await page.getByRole("button", { name: "Save Changes", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "Couldn't confirm changes. Your draft is kept." }).waitFor()
      for (const name of ["Boss mode", "Lattice", "Kanban"])
        assert.equal(await page.getByRole("switch", { name, exact: true }).isChecked(), true)
      assert.equal(await page.getByText("private fixture diagnostic", { exact: false }).count(), 0)
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await until(
        async () => (await page.getByText("Saved. Restart to apply.", { exact: true }).count()) === 3,
        "Saved experiments must remain pending",
      )
      assert.equal(await retained.count(), 0, "Saving removes an uninstalled choice")
      await page.screenshot({ path: path.join(home, "full-experiments-saved.png"), animations: "disabled" })
      await page.getByRole("button", { name: "Close settings", exact: true }).click()
      await visibleFeatures(navigation, features, checks, page.locator(".sb-globals"))
      await stop()
      const enabled = await start()
      for (const id of ["boss", "lattice", "kanban"]) assert.ok(enabled.includes(id))
      await until(
        async () =>
          (await page.locator(".sb-globals").getByRole("button", { name: "Kanban", exact: true }).count()) > 0,
        "Reconnect must discover enabled experiments",
      )
      await inspectWorkflows(enabled, checks)
      await page.goto(origin + "/kanban")
      await page.locator('[data-component="kanban-panel"]').waitFor()
      await page.goto(origin + "/aG9tZQ/session")
      await openExperiments()
      for (const name of ["Boss mode", "Lattice", "Kanban"])
        await page.getByRole("switch", { name, exact: true }).press("Space")
      await page.getByRole("button", { name: "Save Changes", exact: true }).click()
      await until(
        async () => (await page.getByText("Saved. Restart to apply.", { exact: true }).count()) === 3,
        "Disabling must remain pending until restart",
      )
      await page.getByRole("button", { name: "Close settings", exact: true }).click()
      await stop()
      const disabled = await start()
      for (const id of ["boss", "lattice", "kanban"]) assert.ok(!disabled.includes(id))
      await until(
        async () =>
          (await page.locator(".sb-globals").getByRole("button", { name: "Agenda", exact: true }).count()) > 0 &&
          (await page.locator(".sb-globals").getByRole("button", { name: "Kanban", exact: true }).count()) === 0,
        "Reconnect must remove disabled experiments",
      )
      await inspectWorkflows(disabled, checks)
      await page.goto(origin + "/kanban")
      await page.waitForURL(origin + "/aG9tZQ/session")
      checks.push("experiments: failed reads/writes, retry, restart, reconnect, disable and deep-link admission")
    }
    await page.evaluate(() => window.localStorage.clear())
    await page.goto("about:blank")
    await stop()
  }
  for (const result of results) {
    const observed = requests.filter(
      (request) => request.selection === result.selection && request.phase !== "experimental-restart",
    )
    assert.deepEqual(
      observed.filter((request) => request.owner && !result.features.includes(request.owner)),
      [],
    )
    result.requests = observed.length
  }
} catch (error) {
  console.error(
    `${selection}/${phase}`,
    await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  )
  await page.screenshot({ path: path.join(home, `${selection}-${phase}-failure.png`) }).catch(() => {})
  throw error
} finally {
  await Bun.write(
    path.join(home, "result.json"),
    JSON.stringify({ results, requests, responses, successfulResponses, pageErrors }, null, 2),
  )
  await browser.close()
  await stop()
  console.log(JSON.stringify({ home, port, stopped: true, completed: results.length }))
}
