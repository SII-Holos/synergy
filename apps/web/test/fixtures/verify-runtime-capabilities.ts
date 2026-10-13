import assert from "node:assert/strict"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const repository = path.resolve(import.meta.dir, "../../../..")
if (process.argv[2] === "server") {
  const [home, port, selected] = process.argv.slice(3)
  const [{ openAgentRuntime }, { localRuntime }, { server }, { webApp }, { note }] = await Promise.all([
    import(path.join(repository, "packages/agent-runtime/src/index.ts")),
    import(path.join(repository, "packages/local-runtime/src/component.ts")),
    import(path.join(repository, "packages/server/src/component.ts")),
    import(path.join(repository, "packages/server/src/web-app.ts")),
    import(path.join(repository, "packages/note/src/component.ts")),
  ])
  const selectedComponents = async () => {
    if (selected === "core") return []
    if (selected === "note") return [note()]
    if (selected === "lattice") {
      const [{ blueprint }, { lattice }] = await Promise.all([
        import(path.join(repository, "packages/blueprint/src/component.ts")),
        import(path.join(repository, "packages/lattice/src/component.ts")),
      ])
      return [note(), blueprint(), lattice()]
    }
    if (selected === "full") {
      const [{ fullComponents }, { plugins }] = await Promise.all([
        import(path.join(repository, "packages/presets/src/components.ts")),
        import(path.join(repository, "packages/plugin-host/src/component.ts")),
      ])
      process.env.SYNERGY_CONFIG_CONTENT = JSON.stringify({
        anima: { enabled: false },
        boss: { enabled: false },
        holos: { enabled: false },
        library: { experience: { retrieve: false, encode: false } },
        pluginMarketplace: { enabled: false },
        channel: {},
        mcp: {},
        plugin: [],
      })
      return [plugins(), ...fullComponents().filter((component: { id: string }) => component.id !== "server")]
    }
    const exports: Record<string, string> = {
      library: "library",
      agenda: "agenda",
      "light-loop": "lightLoop",
      email: "email",
      channels: "channels",
      blueprint: "blueprint",
      workbench: "workbench",
    }
    const factory = exports[selected!]
    if (!factory) throw new Error(`Unknown acceptance selection: ${selected}`)
    if (selected === "library")
      process.env.SYNERGY_CONFIG_CONTENT = JSON.stringify({
        library: { experience: { retrieve: false, encode: false } },
      })
    const module = await import(path.join(repository, `packages/${selected}/src/component.ts`))
    return [...(selected === "blueprint" ? [note()] : []), module[factory]()]
  }
  const runtime = await openAgentRuntime({
    home: home!,
    mode: "server",
    network: { hostname: "127.0.0.1", port: Number(port), mdns: false },
    components: [
      localRuntime({ workers: false }),
      ...(await selectedComponents()),
      server(),
      webApp({ directory: path.join(repository, "apps/web/dist") }),
      {
        id: "acceptance-readiness",
        apiVersion: 1,
        version: "1.0.0",
        register() {},
        services: () => ({
          started: async () => {
            if (selected === "note") await Bun.sleep(1200)
          },
        }),
      },
    ],
  })
  const historyFile = Bun.file(path.join(home!, "history-seed.json"))
  if (selected === "lattice") {
    const { seedBlueprintSourceHistory } = await import("./blueprint-source-seed")
    await seedBlueprintSourceHistory(repository, home!, runtime)
  }
  if (selected === "note" && !(await historyFile.exists())) {
    const [{ Session }, { Scope }, { ScopeContext }, { Identifier }, { Asset }] = await Promise.all([
      import(path.join(repository, "packages/harness/src/session/index.ts")),
      import(path.join(repository, "packages/harness/src/scope/index.ts")),
      import(path.join(repository, "packages/harness/src/scope/context.ts")),
      import(path.join(repository, "packages/harness/src/id/id.ts")),
      import(path.join(repository, "packages/harness/src/asset/asset.ts")),
    ])
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ title: "Capability history acceptance" })
          const rootID = Identifier.ascending("message")
          const messageID = Identifier.ascending("message")
          const notePartID = Identifier.ascending("part")
          const now = Date.now()
          await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            time: { created: now },
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
            rootID,
            isRoot: true,
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: rootID,
            type: "text",
            text: "Preserved original request",
          })
          const image = async (filename: string, text: string) => ({
            type: "attachment" as const,
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            mime: "image/svg+xml",
            filename,
            presentation: { purpose: "deliverable" as const },
            url: `asset://${await Asset.write(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="40">${text}</text></svg>`), "image/svg+xml", filename)}`,
          })
          await Session.updatePart({ ...(await image("sent-attachment.svg", "Sent attachment")), messageID: rootID })
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "assistant",
            parentID: rootID,
            rootID,
            modelID: "fixture",
            providerID: "fixture",
            mode: "test",
            agent: "general",
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now + 1, completed: now + 2 },
            finish: "stop",
          })
          await Session.updatePart({
            id: notePartID,
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: "history-note-search",
            tool: "note_search",
            state: {
              status: "completed",
              input: { query: "retained history" },
              output: JSON.stringify({ control: "private optional control metadata" }),
              title: "Historical Note search",
              metadata: {},
              time: { start: now, end: now + 1 },
            },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: "history-media-failure",
            tool: "openai_image_generate",
            state: {
              status: "error",
              input: {},
              error: "Historical media generation failure",
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
              time: { start: now, end: now + 1 },
            },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: "history-media-completed",
            tool: "openai_image_generate",
            state: {
              status: "completed",
              input: {},
              output: "",
              title: "Completed image",
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
              attachments: [await image("completed-media.svg", "Completed media")],
              time: { start: now, end: now + 1 },
            },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            text: "Preserved ordinary answer",
          })
          await Session.flushPartWrites(session.id)
          await Bun.write(historyFile, JSON.stringify({ sessionID: session.id, notePartID }))
        },
      }),
    )
  }
  console.log("ready")
  await new Promise<void>((resolve) => process.once("SIGTERM", () => void runtime.close().then(resolve)))
  process.exit(0)
}

const home = await mkdtemp(path.join(tmpdir(), "synergy-capability-acceptance-"))
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
let child: ReturnType<typeof Bun.spawn> | undefined
let log: number | undefined
let generation = 0
let activeFeatures: string[] | undefined
const requests: Array<{ path: string; method: string; generation: number }> = []
const checks: string[] = []
const pageErrors: string[] = []
const capabilityResponses: Array<{ status: number; generation: number }> = []
const absentAPI =
  /^\/(?:note|blueprint|library|agenda|lattice|boss|anima|channel|holos|email|plugin|mcp|lsp|formatter|browser|computer|performance)(?:\/|$)/
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" })
const historyPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" })
historyPage.setDefaultTimeout(15000)
let historyFeatures: string[] | undefined
historyPage.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
historyPage.on("request", (request) => {
  if (!["fetch", "xhr"].includes(request.resourceType())) return
  const url = new URL(request.url())
  if (url.origin === origin) requests.push({ path: url.pathname, method: request.method(), generation })
})
historyPage.on("requestfailed", (request) => {
  if (request.resourceType() === "script") console.error("history module failed", request.url(), request.failure())
})
historyPage.on("response", (response) => {
  const pathname = new URL(response.url()).pathname
  if (/\/(?:part\/page|part\/[^/]+\/content|timeline\/page)$/.test(pathname)) {
    void response
      .text()
      .then((body) => Bun.write(path.join(home, `response-${pathname.replaceAll("/", "_")}.json`), body))
      .catch(() => {})
  }
  if (new URL(response.url()).pathname !== "/global/capabilities" || !response.ok()) return
  void response
    .json()
    .then((value) => {
      historyFeatures = value.features
    })
    .catch(() => {})
})
page.setDefaultTimeout(15000)
page.on("pageerror", (error) => {
  pageErrors.push(error.stack ?? error.message)
  console.error("browser error", error.stack ?? error.message)
})
page.on("request", (request) => {
  if (!["fetch", "xhr"].includes(request.resourceType())) return
  const url = new URL(request.url())
  if (url.origin === origin) requests.push({ path: url.pathname, method: request.method(), generation })
})
page.on("response", (response) => {
  if (new URL(response.url()).pathname !== "/global/capabilities") return
  capabilityResponses.push({ status: response.status(), generation })
  if (!response.ok()) return
  void response
    .json()
    .then((value) => {
      activeFeatures = value.features
    })
    .catch(() => {})
})
console.log(JSON.stringify({ home, origin }))

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(10000).then(() => false)])
    if (!stopped) {
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
async function start(selected: "core" | "note") {
  assert.equal(child, undefined)
  generation++
  activeFeatures = undefined
  historyFeatures = undefined
  log = openSync(path.join(home, `server-${generation}-${selected}.log`), "w")
  child = Bun.spawn([process.execPath, import.meta.filename, "server", home, String(port), selected], {
    cwd: repository,
    env,
    stdin: "ignore",
    stdout: log,
    stderr: log,
  })
  await until(async () => {
    if (child?.exitCode !== null)
      throw new Error(`Server exited: ${child?.exitCode}; inspect server-${generation}-${selected}.log`)
    return fetch(origin + "/global/health", { signal: AbortSignal.timeout(500) }).then(
      (response) => response.ok,
      () => false,
    )
  }, "Server did not become healthy")
  console.log(`ready ${generation} ${selected}`)
}
function check(condition: unknown, message: string) {
  assert.ok(condition, message)
  checks.push(message)
  console.log(message)
}
async function ready(selected: "core" | "note") {
  await page.waitForFunction(() => document.getElementById("synergy-app-boot") === null)
  await until(
    () => activeFeatures !== undefined && activeFeatures.includes("note") === (selected === "note"),
    "Browser did not converge to current capabilities",
  )
  await page.waitForTimeout(300)
}
async function absentNavigation(target: Page) {
  for (const label of ["Agenda", "Kanban", "Library", "Performance", "Plugins", "Notes"])
    check((await target.getByRole("button", { name: label, exact: true }).count()) === 0, `absent navigation: ${label}`)
}

try {
  await start("core")
  await page.goto(origin)
  await ready("core")
  await absentNavigation(page)
  for (const route of ["/agenda", "/kanban", "/library", "/performance", "/plugins/marketplace"]) {
    await page.goto(origin + route)
    await page.waitForURL(origin + "/aG9tZQ/session")
  }
  check(
    requests.filter((request) => request.generation === generation && absentAPI.test(request.path)).length === 0,
    "core deep links make no optional requests",
  )
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole("button", { name: "Open tools", exact: true }).click()
  await page.screenshot({ path: path.join(home, "core-mobile.png") })
  await absentNavigation(page)
  await page.getByRole("button", { name: "Close tools", exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await stop()
  await start("note")
  await ready("note")
  check(
    capabilityResponses.some((response) => response.generation === generation && response.status === 503),
    "same-URL restart retries real startup 503 before publishing Note",
  )
  const created = await client.note.create({
    scopeID: "home",
    noteCreateInput: {
      title: "Capability acceptance note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Stored note text" }] }] },
    },
  })
  check(!!created.data?.id, "Note writes succeed after selecting Note")
  await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
  await page.getByRole("button", { name: "Notes", exact: true }).click()
  await page.getByText("Capability acceptance note", { exact: true }).last().click()
  const editor = page.locator(".note-workspace-editor-layout .tiptap[contenteditable=true]")
  await editor.waitFor()
  check((await editor.textContent())?.includes("Stored note text"), "Note resource loads from the selected backend")
  await editor.fill("Saved through the browser")
  await until(
    async () =>
      JSON.stringify((await client.note.get({ scopeID: "home", id: created.data!.id })).data).includes(
        "Saved through the browser",
      ),
    "Note browser autosave did not reach backend",
  )
  await until(() => Bun.file(path.join(home, "history-seed.json")).exists(), "History fixture was not seeded")
  const history = (await Bun.file(path.join(home, "history-seed.json")).json()) as {
    sessionID: string
    notePartID: string
  }
  await historyPage.goto(`${origin}/aG9tZQ/session/${history.sessionID}`)
  await historyPage.getByText("Preserved ordinary answer", { exact: true }).waitFor()
  const historyStep = historyPage.locator(`[data-part-id="${history.notePartID}"] [data-slot="activity-step-trigger"]`)
  if (!(await historyStep.isVisible())) {
    await historyPage.locator('[data-slot="turn-process-trigger"][aria-expanded="false"]').click()
    await historyPage.locator('[data-component="conversation-activity"] > button[aria-expanded="false"]').click()
  }
  await historyStep.click()
  await historyPage.locator('[data-component="execution-detail"]').waitFor()
  check(
    (await historyPage.getByRole("tab", { name: /execution|search|note/i }).count()) > 0,
    "selected Note history opens its execution detail",
  )
  check(
    (await historyPage.locator('[data-component="media-generation-card"]').count()) === 0,
    "absent Media hides failed history cards",
  )
  await historyPage.getByRole("img", { name: "completed-media.svg", exact: true }).waitFor()
  await historyPage.getByRole("img", { name: "sent-attachment.svg", exact: true }).waitFor()
  check(true, "ordinary sent attachments and completed Media remain visible")
  await editor.fill("Unsaved draft retained across removal")
  await stop()
  await start("core")
  await ready("core")
  await until(
    () => historyFeatures !== undefined && !historyFeatures.includes("note"),
    "History page did not remove Note",
  )
  await historyPage.locator('[data-component="execution-detail"]').waitFor({ state: "detached" })
  check((await historyStep.count()) === 0, "removed Note hides historical controls and execution detail")
  check(
    !(await historyPage.locator("body").innerText()).includes("private optional control metadata"),
    "removed Note does not expose structured control metadata",
  )
  await historyPage.getByText("Preserved original request", { exact: true }).waitFor()
  await historyPage.getByText("Preserved ordinary answer", { exact: true }).waitFor()
  await historyPage.getByRole("img", { name: "completed-media.svg", exact: true }).waitFor()
  await historyPage.getByRole("img", { name: "sent-attachment.svg", exact: true }).waitFor()
  check(true, "owner removal preserves original messages and finished attachments")
  await historyPage.getByRole("heading", { name: "New tab", exact: true }).waitFor()
  check(
    (await historyPage.locator(".workbench-surface-load-error,.workbench-surface-error").count()) === 0,
    "removed history returns to a working resource home without an unavailable card",
  )
  check((await editor.count()) === 0, "removed Note editor and resource tabs disappear after same-URL reconnect")
  await page.waitForTimeout(1500)
  check(
    requests.filter((request) => request.generation === generation && absentAPI.test(request.path)).length === 0,
    "removed Note performs no optional requests or autosaves",
  )
  check(
    requests.filter((request) => request.generation === generation && request.path.endsWith("/activity")).length === 0,
    "removed Note performs no historical execution reads",
  )
  const draftSaved = await page.evaluate(() =>
    Object.values(localStorage).some((value) => value.includes("Unsaved draft retained across removal")),
  )
  check(draftSaved, "removed Note retains the local draft")
  await page.screenshot({ path: path.join(home, "core-after-note-removal.png") })
  await historyPage.screenshot({ path: path.join(home, "history-after-note-removal.png") })
  await stop()
  await start("note")
  await ready("note")
  await until(() => historyFeatures?.includes("note") === true, "History page did not restore Note")
  await historyPage
    .getByRole("tab", { name: /execution|search|note/i })
    .first()
    .click()
  await historyPage.locator('[data-component="execution-detail"]').waitFor()
  check(true, "reinstalled Note restores its retained historical detail tab")
  await page.getByRole("tab", { name: /Capability acceptance note/ }).click()
  await editor.waitFor()
  check(
    (await editor.textContent())?.includes("Unsaved draft retained across removal"),
    "reinstalled Note restores its saved tab and local draft",
  )
  check(
    JSON.stringify((await client.note.get({ scopeID: "home", id: created.data!.id })).data).includes(
      "Saved through the browser",
    ),
    "reinstallation preserves the last durable Note revision",
  )
  await page.screenshot({ path: path.join(home, "note-restored.png") })
  check(pageErrors.length === 0, "all restart phases have no browser page errors")
  await Bun.write(
    path.join(home, "result.json"),
    JSON.stringify({ checks, pageErrors, requests, capabilityResponses }, null, 2),
  )
} catch (error) {
  console.error(
    "page text",
    await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  )
  await page.screenshot({ path: path.join(home, "failure.png") }).catch(() => {})
  console.error(
    "history page text",
    await historyPage
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  )
  await historyPage.screenshot({ path: path.join(home, "history-failure.png") }).catch(() => {})
  await Bun.write(
    path.join(home, "result.json"),
    JSON.stringify({ checks, pageErrors, requests, capabilityResponses }, null, 2),
  )
  throw error
} finally {
  await browser.close()
  await stop()
  console.log(JSON.stringify({ home, port, stopped: true, checks: checks.length }))
}
