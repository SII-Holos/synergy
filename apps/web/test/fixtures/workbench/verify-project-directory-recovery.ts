import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
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
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-directory-recovery-")))
const folders = ["main", "shared"].map((name) => path.join(fixture, name))
const output = path.join(root, "evidence", path.basename(fixture))
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
const agent = (await client.app.agents({ scopeID }, options)).data.find(
  (item) => item.mode === "primary" && !item.hidden,
)!
assert.ok(agent, "A primary agent must be available")
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
    agent: agent.name,
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
page.setDefaultTimeout(60000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const route = url.origin + "/" + Buffer.from(scopeID).toString("base64url") + "/session"
const trigger = page.locator("[data-worktree-task-selector]")
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const recovery = page.getByRole("dialog", { name: /恢复项目目录|Restore project folders/ })
const continueRecovery = recovery.getByRole("button", {
  name: /^(继续使用这些目录|Continue using these folders)$/,
})
async function openRecovery() {
  await trigger.click()
  const menu = page.getByRole("dialog", { name: /^Worktrees?$/ })
  await menu.getByRole("button", { name: /^(新建 Worktree|New Worktree)/ }).click()
  await continueRecovery.waitFor()
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
    assert.equal(await recovery.getByRole("button", { name: /^(选择其他目录|Choose another folder)$/ }).count(), 2)
    for (const reason of await recovery.locator(".project-recovery-reason").all()) {
      assert.equal(await reason.isVisible(), true)
      assert.ok((await reason.innerText()).trim())
    }
    assert.equal(await recovery.getByRole("textbox").count(), 0)
    await page.screenshot({ path: path.join(output, `${theme}-confirmation.png`), animations: "disabled" })
    await recovery.getByRole("button", { name: /^(取消|Cancel)$/ }).click()
    await recovery.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-worktree-task-selector"))
    assert.equal(await editor.innerText(), "恢复目录后保留的草稿")
    assert.equal(await editorNode!.evaluate((node) => node.isConnected), true)
    assert.deepEqual((await client.workspace.list({ scopeID }, options)).data, original)
  }
  await openRecovery()
  await continueRecovery.click()
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
  for (const scenario of ["replaced", "already-rebound"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(route)
    await trigger.click()
    await page.getByRole("button", { name: /^(主目录|Main folder)$/ }).click()
    const draft = `Retain first-send draft after ${scenario}`
    await editor.fill(draft)
    const before = (await client.workspace.list({ scopeID }, options)).data.find(
      (item) => item.id === main.workspaceID,
    )!
    if (scenario === "replaced") {
      await rename(folders[0]!, folders[0] + "-recovered")
      await cp(folders[0] + "-recovered", folders[0]!, { recursive: true })
    } else {
      await client.workspace.rebind(
        { scopeID, workspaceID: before.id, expectedRevision: before.revision, path: folders[0]! },
        options,
      )
    }
    const sends: number[] = []
    const observe = (response: import("playwright").Response) => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
        sends.push(response.status())
    }
    page.on("response", observe)
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/session" &&
        response.status() === 409,
    )
    await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click()
    await rejected
    await page.getByRole("dialog", { name: /^(选择工作目录|Choose a working directory)$/ }).waitFor()
    const chooser = page.getByRole("dialog").first()
    assert.equal(sends.length, 1)
    assert.equal(sends[0], 409)
    if (scenario === "replaced") {
      await chooser.getByRole("button", { name: /^(重新关联目录|Reconnect directory)$/ }).click()
      await chooser.getByRole("button", { name: /^(确认目录|Confirm directory)$/ }).click()
      await page
        .getByRole("dialog", { name: /^(更换本地目录|Change local directory)$/ })
        .getByRole("button", { name: /^(确认目录|Confirm directory)$/ })
        .click()
    } else {
      await chooser.locator(`[data-workspace-id="${main.workspaceID}"]`).click()
      await chooser.getByRole("button", { name: /^(使用此目录|Use this directory)$/ }).click()
    }
    await chooser.waitFor({ state: "hidden" })
    await page.waitForFunction(
      (text) => [...document.querySelectorAll('[contenteditable="true"]')].some((item) => item.textContent === text),
      draft,
    )
    assert.equal(sends.length, 1, "Recovery must not send automatically")
    assert.equal(await editor.innerText(), draft)
    await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click()
    await page.waitForURL(/\/session\/ses_/)
    await page.getByText("已收到测试任务。", { exact: false }).first().waitFor()
    page.off("response", observe)
    assert.deepEqual(sends, [409, 200])
    const selected = (await client.session.get({ scopeID, sessionID: page.url().split("/").at(-1)! }, options)).data
    const current = (await client.workspace.list({ scopeID }, options)).data.find(
      (item) => item.id === main.workspaceID,
    )!
    assert.equal(selected.workspaceID, main.workspaceID)
    assert.equal(selected.workspace?.generation, current.binding.generation)
    await page.screenshot({ path: path.join(output, `${scenario}-sent.png`), animations: "disabled" })
  }
  assert.deepEqual(errors, [])
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        checks: [
          "structured failure reasons",
          "visible recovery reasons and alternative folder actions",
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
          "first-send replacement confirmation applies the recovered generation",
          "stale explicit draft selects an already-rebound directory",
          "failed-send draft retained without automatic submission",
        ],
        viewport: page.viewportSize(),
        fixture,
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
