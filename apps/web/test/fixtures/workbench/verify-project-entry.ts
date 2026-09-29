import assert from "node:assert/strict"
import { chmod, mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
assert.ok(home && origin, "Usage: verify-project-entry.ts <isolated-home> <production-origin>")
const url = new URL(origin)
assert.equal(url.hostname, "127.0.0.1")
assert.ok(url.port && url.protocol === "http:")
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true as const }
const paths = (await client.path.get({ scopeID: "home" }, options)).data
assert.equal(await realpath(paths.home), await realpath(home))
assert.notEqual(await realpath(home), await realpath(homedir()))
const manifest = (await Bun.file(path.join(home, "workbench-fixtures.json")).json()) as { scopes: string[] }
const projectID = manifest.scopes[2]!
const output = path.join(home, "evidence", "project-entry", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const directories = path.join(home, "directory-fixtures")
await Promise.all(
  Array.from({ length: 120 }, (_, i) =>
    mkdir(path.join(directories, "folder-" + String(i).padStart(3, "0")), { recursive: true }),
  ),
)
await mkdir(path.join(directories, ".hidden-folder"), { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  recordVideo: { dir: output },
})
const page = await context.newPage()
page.setDefaultTimeout(12000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const checks: string[] = []
const check = (value: unknown, name: string) => {
  assert.ok(value, name)
  checks.push(name)
}
const route = (scope: string) => url.origin + "/" + Buffer.from(scope).toString("base64url") + "/session"
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const picker = page.locator("[data-project-task-selector]")
const topDialog = () => page.getByRole("dialog").last()
const more = page.locator(".session-work-context-more")
async function open(scope = "home") {
  await page.goto(route(scope))
  await editor.waitFor()
}
async function closeDialog() {
  const id = await topDialog().getAttribute("id")
  assert.ok(id)
  await page.keyboard.press("Escape")
  await page.locator(`[id="${id}"]`).waitFor({ state: "hidden" })
}
async function selectProject() {
  await picker.click()
  await topDialog()
    .getByRole("button", { name: /^Frontend Lab / })
    .click()
}
async function settings() {
  await more.click()
  await topDialog()
    .getByRole("button", { name: /^(项目设置|Project settings)$/ })
    .click()
}
async function folderPath(value: string) {
  await topDialog()
    .getByRole("textbox", { name: /^(文件夹路径|Folder path)$/ })
    .fill(value)
  await topDialog()
    .getByRole("button", { name: /^(前往|Go)$/ })
    .click()
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
        /正在加载文件夹|Loading folders/.test(el.textContent ?? ""),
      ),
  )
}
try {
  await open(projectID)
  await editor.fill("目标项目原有草稿")
  await open()
  check(
    (await page.locator(".session-work-context").innerText()).includes("选择项目"),
    "global task has one primary project entry",
  )
  check(
    !/Workspace|Environment|使用配置的默认值/.test(await page.locator(".session-work-context").innerText()),
    "technical selectors are absent from the normal composer",
  )
  await editor.fill("当前任务中文草稿")
  let releaseUpload!: () => void
  let uploadStarted!: () => void
  const uploading = new Promise<void>((resolve) => {
    uploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  await page.route(
    (url) => url.pathname === "/asset",
    async (route) => {
      uploadStarted()
      await uploadGate
      await route.continue()
    },
    { times: 1 },
  )
  try {
    await page.locator('input[type="file"]').setInputFiles(path.join(home, "fixture.txt"))
    await uploading
    check(await picker.isDisabled(), "project switching waits for uploads to finish")
  } finally {
    releaseUpload()
  }
  await page.getByText("fixture.txt", { exact: true }).first().waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-project-task-selector]")?.disabled)
  await selectProject()
  await topDialog()
    .getByRole("button", { name: /^(取消|Cancel)$/ })
    .click()
  await closeDialog()
  check((await editor.innerText()) === "当前任务中文草稿", "cancel merge preserves source text")
  check(page.url() === route("home"), "cancel merge preserves source project")
  await selectProject()
  await topDialog()
    .getByRole("button", { name: /合并并切换|Merge and switch/ })
    .click()
  await page.waitForURL(route(projectID))
  await editor.waitFor()
  check(
    (await editor.innerText()).replace(/\u200b/g, "") === "目标项目原有草稿\n\n当前任务中文草稿",
    "merge keeps target before source",
  )
  check(
    await page.getByText("fixture.txt", { exact: true }).first().isVisible(),
    "uploaded attachment survives project transfer",
  )
  check(
    !/独立副本|Independent copy/.test(await page.locator(".session-work-context").innerText()),
    "ordinary folders and canonical path aliases are not inferred as copies",
  )
  check(
    !/此 Mac|This Mac/.test(await page.locator(".session-work-context").innerText()),
    "standalone Web never claims desktop-local execution",
  )
  await settings()
  const name = topDialog().getByRole("textbox", { name: /^(项目名称|Project name)$/ })
  await name.fill("unsaved name")
  await page.keyboard.press("Escape")
  await topDialog()
    .getByRole("button", { name: /^(取消|Cancel)$/ })
    .click()
  check((await name.inputValue()) === "unsaved name", "cancel discard keeps project form input")
  await name.fill("Frontend Lab")
  const defaults = topDialog()
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /新任务默认设置|New task defaults/ }) })
  await defaults.getByLabel(/^(运行位置|Execution location)$/).selectOption("none")
  await defaults.getByRole("button", { name: /^(保存|Save)$/ }).click()
  await defaults.getByText(/^(已保存|Saved)$/).waitFor()
  check(
    (await client.project.taskDefaults.get({ scopeID: projectID }, options)).data.defaults
      .defaultSessionEnvironmentProfile === null,
    "project defaults save independently",
  )
  await defaults.getByLabel(/^(运行位置|Execution location)$/).selectOption("inherit")
  await defaults.getByRole("button", { name: /^(保存|Save)$/ }).click()
  await defaults.getByText(/^(已保存|Saved)$/).waitFor()
  await topDialog()
    .getByRole("button", { name: /^(添加文件夹|Add folder)$/ })
    .click()
  await folderPath(directories)
  await topDialog()
    .getByRole("button", { name: /加载更多文件夹|Load more folders/ })
    .click()
  await page.waitForFunction(() => document.querySelectorAll(".directory-navigation-entry").length >= 120)
  checks.push("directory browser paginates the real service listing")
  await topDialog().getByRole("button", { name: "folder-000", exact: true }).click()
  await topDialog().getByRole("button", { name: "folder-119", exact: true }).click()
  await topDialog()
    .getByRole("button", { name: /使用选中的文件夹|Use selected folders/ })
    .click()
  check(
    (await topDialog().innerText()).includes("folder-000") && (await topDialog().innerText()).includes("folder-119"),
    "multi-selection returns both folders to the preserved form",
  )
  await page.keyboard.press("Escape")
  await topDialog()
    .getByRole("button", { name: /放弃修改|Discard changes/ })
    .click()
  await closeDialog()
  const resourcesBefore = (await client.environment.list({ scopeID: projectID }, options)).data
  await more.click()
  await topDialog()
    .getByRole("button", { name: /^(运行位置|Execution location)$/ })
    .click()
  await topDialog()
    .getByRole("button", { name: /native/ })
    .click()
  await closeDialog()
  await closeDialog()
  check(
    JSON.stringify((await client.environment.list({ scopeID: projectID }, options)).data) ===
      JSON.stringify(resourcesBefore),
    "previewing execution locations does not allocate or mutate resources",
  )
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, height] of [
      [1440, 900],
      [800, 700],
      [375, 740],
      [1440, 480],
    ]) {
      await page.setViewportSize({ width: width!, height: height! })
      const label = colorScheme + "-" + width + "x" + height
      await page.screenshot({ path: path.join(output, label + "-composer.png") })
      await picker.click()
      await page.screenshot({ path: path.join(output, label + "-projects.png") })
      const bounds = (await topDialog().boundingBox())!
      check(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width! + 1 &&
          bounds.y + bounds.height <= height! + 1,
        label + ": project dialog fits",
      )
      await closeDialog()
      await settings()
      await topDialog()
        .getByRole("button", { name: /^(添加文件夹|Add folder)$/ })
        .click()
      await folderPath(directories)
      const actions = (await topDialog().locator('[data-slot="dialog-actions"]').boundingBox())!
      check(actions.y >= 0 && actions.y + actions.height <= height! + 1, label + ": folder confirmation is visible")
      await page.screenshot({ path: path.join(output, label + "-folders.png") })
      await closeDialog()
      await page.screenshot({ path: path.join(output, label + "-settings.png") })
      await closeDialog()
      await closeDialog()
      check(await picker.isVisible(), label + ": composer remains usable")
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await picker.click()
  await topDialog()
    .getByRole("button", { name: /^(打开文件夹|Open folder)$/ })
    .click()
  await folderPath(path.join(directories, "folder-000"))
  await topDialog()
    .getByText(/没有子文件夹|has no subfolders/)
    .waitFor()
  checks.push("empty folders remain selectable")
  await folderPath(path.join(directories, "missing"))
  await topDialog().getByRole("alert").waitFor()
  check(
    (
      await topDialog()
        .getByRole("textbox", { name: /文件夹路径|Folder path/ })
        .inputValue()
    ).endsWith("missing"),
    "invalid path error retains the attempted path",
  )
  check(
    await topDialog()
      .getByRole("button", { name: /^(使用此文件夹|Use this folder)$/ })
      .isDisabled(),
    "invalid folder cannot be confirmed",
  )
  await folderPath(directories)
  await topDialog()
    .locator('[data-slot="checkbox-checkbox-label"]')
    .filter({ hasText: /显示隐藏文件夹|Show hidden folders/ })
    .click()
  await topDialog().getByRole("button", { name: ".hidden-folder", exact: true }).waitFor()
  await topDialog()
    .getByRole("textbox", { name: /搜索当前目录|Search folders here|搜索此处的文件夹/ })
    .fill("no-folder-matches-this")
  await topDialog()
    .getByRole("button", { name: /搜索当前目录|Search folders here|搜索此处的文件夹/ })
    .click()
  await topDialog()
    .getByText(/没有匹配|No matching/)
    .waitFor()
  checks.push("hidden folders and distinct empty-search state")
  await closeDialog()
  await closeDialog()
  await editor.fill("[project-entry] 验证选择项目后的首条发送")
  await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click()
  await page.waitForURL(/\/session\/ses_/)
  await page.getByText("已收到测试任务。", { exact: false }).first().waitFor()
  const sessionID = page.url().split("/").at(-1)!
  const created = (await client.session.get({ scopeID: projectID, sessionID }, options)).data
  check(created.scope.id === projectID && !!created.workspaceID, "first send binds the selected project files")
  check(
    !created.workspace || created.workspace.type !== "git_worktree",
    "new task does not copy project files by default",
  )
  await page.screenshot({ path: path.join(output, "existing-session.png") })
  const gitDirectory = path.join(home, "projects", "Copy Acceptance " + Date.now())
  await mkdir(gitDirectory, { recursive: true })
  for (const args of [
    ["init", "--quiet"],
    [
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "Create acceptance fixture",
    ],
  ]) {
    const process = Bun.spawn(["git", ...args], { cwd: gitDirectory, stdout: "pipe", stderr: "pipe" })
    assert.equal(await process.exited, 0, await new Response(process.stderr).text())
  }
  const gitScope = (await client.scope.current({ directory: gitDirectory }, options)).data
  await client.scope.update({ path_scopeID: gitScope.id, name: "Copy Acceptance" }, options)
  await open(gitScope.id)
  await editor.fill("[project-entry] 验证独立副本首条发送")
  const copiesBefore = (await client.workspace.list({ scopeID: gitScope.id }, options)).data
  const computeBefore = (await client.environment.list({ scopeID: gitScope.id }, options)).data
  await more.click()
  await topDialog()
    .getByRole("button", { name: /开始时创建独立副本|Independent copy on start/ })
    .click()
  await topDialog()
    .getByRole("textbox", { name: /副本名称|Copy name/ })
    .fill("login-acceptance")
  await topDialog()
    .getByRole("button", { name: /使用此位置|Use this location/ })
    .click()
  check(
    (await page.locator(".session-work-context").innerText()).includes("login-acceptance"),
    "copy choice is shown before first send",
  )
  check(
    JSON.stringify((await client.workspace.list({ scopeID: gitScope.id }, options)).data) ===
      JSON.stringify(copiesBefore),
    "choosing a copy does not create files",
  )
  check(
    JSON.stringify((await client.environment.list({ scopeID: gitScope.id }, options)).data) ===
      JSON.stringify(computeBefore),
    "choosing a copy does not allocate compute",
  )
  await page.screenshot({ path: path.join(output, "copy-before-send.png") })
  await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click()
  await page.waitForURL(/\/session\/ses_/, { timeout: 30000 })
  await page.getByText("已收到测试任务。", { exact: false }).first().waitFor()
  const copySession = (
    await client.session.get({ scopeID: gitScope.id, sessionID: page.url().split("/").at(-1)! }, options)
  ).data
  check(copySession.workspace?.type === "git_worktree", "first send creates and binds the requested independent copy")
  await page.screenshot({ path: path.join(output, "copy-after-send.png") })
  await open(gitScope.id)
  check(
    !/login-acceptance/.test(await page.locator(".session-work-context").innerText()),
    "another task does not automatically inherit the last temporary copy",
  )
  await more.click()
  await topDialog()
    .getByRole("button", { name: /继续已有副本|Continue an existing copy/ })
    .click()
  await topDialog()
    .getByRole("button", { name: /login-acceptance/ })
    .click()
  await topDialog()
    .getByRole("button", { name: /使用这些文件|Use these files/ })
    .click()
  check(
    (await page.locator(".session-work-context").innerText()).includes("login-acceptance"),
    "existing copy is selected explicitly",
  )
  await page.screenshot({ path: path.join(output, "continue-copy.png") })
  const denied = path.join(directories, "restricted")
  await mkdir(denied, { recursive: true })
  await picker.click()
  await topDialog()
    .getByRole("button", { name: /^(打开文件夹|Open folder)$/ })
    .click()
  await chmod(denied, 0)
  try {
    await folderPath(denied)
    await topDialog().getByRole("alert").waitFor()
    check(
      (await topDialog().innerText()).includes("权限"),
      "directory permission failure is distinct and preserves navigation",
    )
    await page.screenshot({ path: path.join(output, "folder-permission.png") })
  } finally {
    await chmod(denied, 0o700)
  }
  await topDialog()
    .getByRole("button", { name: /重试|Retry/ })
    .click()
  await topDialog()
    .getByText(/没有子文件夹|has no subfolders/)
    .waitFor()
  checks.push("directory retry recovers the same path after permission is restored")
  await closeDialog()
  await closeDialog()
  check(errors.length === 0, "no renderer errors: " + errors.join("; "))
  await Bun.write(path.join(output, "report.json"), JSON.stringify({ origin: url.origin, checks, errors }, null, 2))
  console.log(JSON.stringify({ output, checks: checks.length, errors }))
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined)
  await Bun.write(
    path.join(output, "failure.txt"),
    String(error) + "\n" + (await page.locator("body").innerText()) + "\n" + errors.join("\n"),
  )
  throw error
} finally {
  await context.close()
  await browser.close()
}
