import assert from "node:assert/strict"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin, manifestPath] = process.argv.slice(2)
if (!home || !origin || !manifestPath)
  throw new Error("Usage: verify.ts <isolated-home> <server-origin> <private-manifest.json>")
const url = new URL(origin)
assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port)
const selectedHome = await realpath(home)
assert.notEqual(selectedHome, await realpath(homedir()))
const client = createSynergyClient({ baseUrl: url.origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
assert.equal(await realpath(paths.home), selectedHome)
const manifest = z
  .object({
    sessions: z.array(z.object({ id: z.string(), scopeID: z.string() })).min(2),
    projectScopeID: z.string(),
    projectDirectory: z.string(),
    timeoutMs: z.number().int().positive().default(60_000),
  })
  .parse(await Bun.file(manifestPath).json())
const projectDirectory = await realpath(manifest.projectDirectory)
const { data: project } = await client.scope.current({ scopeID: manifest.projectScopeID }, { throwOnError: true })
assert.equal(await realpath(project.local!.directory), projectDirectory)
const output = path.join(selectedHome, "history-acceptance", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.setDefaultTimeout(manifest.timeoutMs)
const failures: string[] = []
const measurements: { name: string; ms: number }[] = []
let completeSummaryRequests = 0
page.on("pageerror", (error) => failures.push(error.message))
page.on("response", (response) => {
  if (response.status() >= 500) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`)
})
page.on("request", (request) => {
  if (new URL(request.url()).pathname.endsWith("/execution/summary")) completeSummaryRequests++
})
const route = (scopeID: string, sessionID = "") =>
  `${url.origin}/${Buffer.from(scopeID).toString("base64url")}/session${sessionID ? `/${sessionID}` : ""}`
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
async function interactive() {
  await editor.fill("History acceptance draft")
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  await editor.fill("")
}
async function open(scopeID: string, sessionID = "") {
  const started = performance.now()
  await page.goto(route(scopeID, sessionID))
  if (sessionID)
    await page.locator('[data-component="session-turn"]:visible [data-component="text-part"]:visible').first().waitFor()
  await interactive()
  measurements.push({
    name: sessionID ? `historical-${measurements.length}` : "new-composer",
    ms: performance.now() - started,
  })
}
async function send(name: string) {
  await page.getByRole("button", { name: "Workbench Chat", exact: true }).waitFor()
  await editor.fill("History acceptance: reply using the local fixture.")
  const admitted = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session",
  )
  const started = performance.now()
  await editor.press("Enter")
  const response = await admitted
  assert.ok(response.ok(), `${name} admission: HTTP ${response.status()}`)
  const result = (await response.json()) as { id: string; workspace?: { type: string; directories?: string[] } }
  measurements.push({ name: `${name}-admission`, ms: performance.now() - started })
  await page.locator('[data-component="text-part"]:visible').filter({ hasText: "已收到测试任务" }).waitFor()
  await interactive()
  measurements.push({ name: `${name}-reply`, ms: performance.now() - started })
  return result
}
try {
  await open("home")
  for (const session of manifest.sessions) await open(session.scopeID, session.id)
  for (const direction of ["back", "forward"] as const) {
    const started = performance.now()
    if (direction === "back") await page.goBack()
    else await page.goForward()
    await page.locator('[data-component="session-turn"]:visible [data-component="text-part"]:visible').first().waitFor()
    await interactive()
    measurements.push({ name: `history-${direction}`, ms: performance.now() - started })
  }
  await open("home")
  await send("new-session")
  await open(manifest.projectScopeID)
  await page.locator("[data-worktree-task-selector]").click()
  await page.getByRole("button", { name: /新建 Worktree|New Worktree/ }).click()
  const session = await send("new-worktree")
  assert.equal(session.workspace?.type, "git_worktree")
  const { data: stored } = await client.session.get({ sessionID: session.id }, { throwOnError: true })
  assert.equal(await realpath(stored.scope.local!.directory), projectDirectory)
  const workspace = stored.workspace
  assert.ok(workspace?.type === "git_worktree")
  const git = Bun.spawn(["git", "-C", workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const common = (await new Response(git.stdout).text()).trim()
  assert.equal(await git.exited, 0)
  assert.equal(await realpath(common), await realpath(path.join(projectDirectory, ".git")))
  await page.screenshot({ path: path.join(output, "ready.png") })
  assert.equal(completeSummaryRequests, 0, "Navigation must not request complete execution history")
  assert.deepEqual(failures, [])
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {})
  throw error
} finally {
  await Bun.write(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        measurements,
        completeSummaryRequests,
        failures,
        timingPolicy:
          "Generous hang guards; timings are local evidence, not CI workstation thresholds. Reply includes fixture model delay.",
      },
      null,
      2,
    ),
  )
  await browser.close()
  console.log(JSON.stringify({ output, measurements, completeSummaryRequests, failures: failures.length }))
}
