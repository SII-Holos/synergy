import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, realpath, rename, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
assert.ok(home && origin, "Usage: verify-project-directory-recovery.ts <isolated-home> <production-origin>")
const url = new URL(origin)
assert.equal(url.hostname, "127.0.0.1")
assert.equal(url.protocol, "http:")
assert.ok(url.port)
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true as const }
const paths = (await client.path.get({ scopeID: "home" }, options)).data
const root = await realpath(home)
assert.equal(await realpath(paths.home), root)
assert.notEqual(root, await realpath(homedir()))
const fixture = path.join(root, "directory-recovery-fixtures", String(Date.now()))
const folders = ["main", "shared"].map((name) => path.join(fixture, name))
const output = path.join(fixture, "evidence")
await mkdir(output, { recursive: true })
for (const folder of folders) {
  await mkdir(folder)
  await writeFile(path.join(folder, "README.md"), "Directory recovery acceptance fixture")
}
const git = promisify(execFile)
for (const args of [
  ["init", "--quiet"],
  ["add", "."],
  ["-c", "user.name=Acceptance Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture"],
])
  await git("git", args, { cwd: folders[0] })
const project = (
  await client.project.create(
    {
      projectCreateInput: { name: "Directory recovery acceptance", directories: folders, mainDirectory: folders[0]! },
    },
    options,
  )
).data
const scopeID = project.scope.id
const main = (await client.project.directories({ scopeID }, options)).data.folders.find(
  (folder) => folder.workspaceID === project.directories.mainWorkspaceID,
)!
const seed = (
  await client.session.create(
    { scopeID, workspace: { mode: "workspace", workspaceID: main.workspaceID, workspaceGeneration: main.generation } },
    options,
  )
).data
await client.session.shell(
  {
    scopeID,
    sessionID: seed.id,
    command: "true",
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture-chat" },
  },
  options,
)
const original = (await client.workspace.list({ scopeID }, options)).data
assert.equal(
  original.some((workspace) => workspace.id === main.workspaceID && !!workspace.activeMount),
  true,
)
for (const folder of folders) {
  await rename(folder, folder + "-previous")
  await cp(folder + "-previous", folder, { recursive: true })
}
const unavailable = (await client.project.directories({ scopeID }, options)).data
assert.equal(unavailable.folders.length, 2)
for (const folder of unavailable.folders) {
  assert.equal(folder.available, false)
  assert.equal(folder.git, false)
  assert.equal(folder.unavailable?.data.reason, "identity_changed")
}
const requireWeb = createRequire(path.join(process.cwd(), "apps/web/package.json"))
const { chromium } = requireWeb("playwright") as typeof import("playwright")
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const route = url.origin + "/" + Buffer.from(scopeID).toString("base64url") + "/session"
const trigger = page.locator("[data-worktree-task-selector]")
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const recovery = page.getByRole("dialog", { name: /确认项目目录|Confirm project folders/ })
async function openRecovery() {
  await trigger.click()
  const menu = page.getByRole("dialog", { name: /^Worktrees?$/ })
  await menu.getByRole("button", { name: /^(新建 Worktree|New Worktree)/ }).click()
  await recovery.getByRole("button", { name: /^(确认并恢复|Confirm and restore)$/ }).waitFor()
}
try {
  await page.goto(route)
  await editor.fill("恢复目录后保留的草稿")
  const editorNode = await editor.elementHandle()
  const allocations = (items: Awaited<ReturnType<typeof client.environment.list>>["data"]) =>
    items!.map(({ id, allocation }) => ({ id, allocation }))
  const resources = allocations((await client.environment.list({ scopeID }, options)).data)
  for (const selector of [
    "[data-computer-selector]",
    "[data-project-task-selector]",
    "[data-worktree-task-selector]",
  ]) {
    await page.locator(selector).hover()
    await page.locator(selector).focus()
    await page.waitForTimeout(900)
    assert.equal(await page.getByRole("tooltip").count(), 0)
  }
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: theme === "light" ? 1280 : 375, height: theme === "light" ? 900 : 812 })
    await openRecovery()
    for (const folder of folders) assert.equal(await recovery.getByText(folder, { exact: true }).isVisible(), true)
    assert.equal(await recovery.getByRole("button", { name: /^(选择目录|Choose folder)$/ }).count(), 0)
    await page.screenshot({ path: path.join(output, `${theme}-confirmation.png`), animations: "disabled" })
    await recovery.getByRole("button", { name: /^(取消|Cancel)$/ }).click()
    await recovery.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-worktree-task-selector"))
    assert.equal(await editor.innerText(), "恢复目录后保留的草稿")
    assert.equal(await editorNode!.evaluate((node) => node.isConnected), true)
    assert.deepEqual((await client.workspace.list({ scopeID }, options)).data, original)
  }
  await openRecovery()
  await recovery.getByRole("button", { name: /^(确认并恢复|Confirm and restore)$/ }).click()
  await recovery.waitFor({ state: "hidden" })
  assert.match((await trigger.getAttribute("aria-label"))!, /新建 Worktree|New Worktree/)
  const restored = (await client.project.directories({ scopeID }, options)).data
  assert.equal(restored.mainWorkspaceID, unavailable.mainWorkspaceID)
  assert.equal(restored.revision, unavailable.revision)
  for (const folder of restored.folders) {
    assert.equal(folder.available, true)
    assert.equal(folder.unavailable, undefined)
    assert.equal(
      folder.generation,
      unavailable.folders.find((old) => old.workspaceID === folder.workspaceID)!.generation + 1,
    )
  }
  assert.equal(restored.folders.find((folder) => folder.workspaceID === restored.mainWorkspaceID)!.git, true)
  assert.equal((await client.project.worktreeInventory({ scopeID }, options)).data.items.length, 0)
  assert.deepEqual(allocations((await client.environment.list({ scopeID }, options)).data), resources)
  assert.equal(await editor.innerText(), "恢复目录后保留的草稿")
  assert.equal(await editorNode!.evaluate((node) => node.isConnected), true)
  await page.screenshot({ path: path.join(output, "restored-deferred-intent.png"), animations: "disabled" })
  await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click()
  await page.waitForURL(/\/session\/ses_/)
  await page.getByText("已收到测试任务。", { exact: false }).first().waitFor()
  const session = (await client.session.get({ scopeID, sessionID: page.url().split("/").at(-1)! }, options)).data
  assert.equal(session.workspace?.type, "git_worktree")
  const trees = (await client.project.worktrees({ scopeID }, options)).data
  assert.equal(trees.length, 1)
  assert.equal(trees[0]!.sourceDirectory, folders[0])
  assert.equal(trees[0]!.path, session.workspace?.path)
  assert.equal(await page.locator(".session-work-context").count(), 0)
  assert.deepEqual(errors, [])
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        checks: [
          "structured failure reasons",
          "no setup tooltips",
          "light and dark confirmation",
          "narrow viewport",
          "cancel and focus return",
          "retained editor and draft",
          "stale native directory mount cleanup",
          "main and shared folder restoration",
          "deferred selection without allocation",
          "one Worktree on send",
          "original source ownership",
        ],
        viewport: page.viewportSize(),
        errors,
      },
      null,
      2,
    ),
  )
  console.log("Project directory recovery acceptance passed.")
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), timeout: 5000 }).catch(() => {})
  throw error
} finally {
  await context.close()
  await browser.close()
}
