import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin, desktopEndpoint, externalDesktopEndpoint] = process.argv.slice(2)
assert.ok(
  home && origin,
  "Usage: verify-project-entry.ts <isolated-home> <production-origin> [managed-desktop-cdp] [external-desktop-cdp]",
)
const url = new URL(origin)
assert.equal(url.hostname, "127.0.0.1")
assert.ok(url.port && url.protocol === "http:")
const client = createSynergyClient({ baseUrl: url.origin })
const options = { throwOnError: true as const }
const paths = (await client.path.get({ scopeID: "home" }, options)).data
assert.equal(await realpath(paths.home), await realpath(home))
assert.notEqual(await realpath(home), await realpath(homedir()))
if (typeof Bun !== "undefined" && desktopEndpoint) {
  // Electron's inspector transport requires Node; reuse the same runner and current SDK source for both surfaces.
  const runner = path.join(home, "verify-project-entry.mjs")
  const build = await Bun.build({ entrypoints: [import.meta.path], target: "node", conditions: ["bun"], format: "esm" })
  if (!build.success) throw new AggregateError(build.logs, "Could not build Desktop acceptance runner")
  await Bun.write(runner, build.outputs[0])
  const child = Bun.spawn(
    ["node", runner, home, origin, desktopEndpoint, ...(externalDesktopEndpoint ? [externalDesktopEndpoint] : [])],
    {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  process.exit(await child.exited)
}
const requireWeb = createRequire(path.join(process.cwd(), "apps/web/package.json"))
const { chromium } = requireWeb("playwright") as typeof import("playwright")
const git = promisify(execFile)
const stamp = Date.now().toString()
const output = path.join(home, "evidence", "computer-project", stamp)
const fixture = path.join(await realpath(home), "project-flow-fixtures", stamp)
const folders = ["frontend", "backend", "docs"].map((name) => path.join(fixture, name))
await mkdir(output, { recursive: true })
for (const folder of folders) {
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, "README.md"), path.basename(folder) + " acceptance fixture")
}
for (const folder of folders.slice(0, 2)) {
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
  ]) {
    await git("git", args, { cwd: folder })
  }
}
const directoryFixture = path.join(fixture, "listing")
await Promise.all(
  Array.from({ length: 120 }, (_, i) =>
    mkdir(path.join(directoryFixture, `folder-${String(i).padStart(3, "0")}`), { recursive: true }),
  ),
)
await mkdir(path.join(directoryFixture, ".hidden-folder"), { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
})
const started = Date.now()
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const checks: string[] = []
const timeline: Array<{ name: string; milliseconds: number }> = []
function check(value: unknown, name: string) {
  assert.ok(value, name)
  checks.push(name)
  timeline.push({ name, milliseconds: Date.now() - started })
}
const route = (scope: string) => url.origin + "/" + Buffer.from(scope).toString("base64url") + "/session"
const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
const picker = page.locator("[data-project-task-selector]")
const top = () => page.getByRole("dialog").last()
async function settle() {
  await page.mouse.move(0, 0)
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity,
        ),
  )
}
async function close() {
  await settle()
  await page.waitForFunction(() => !document.querySelector('[data-component="tooltip"][data-expanded]'))
  const pathField = top().getByRole("textbox", { name: "文件夹路径", exact: true })
  if (await pathField.isVisible()) {
    await pathField.press("Escape")
    await pathField.waitFor({ state: "detached" })
    check(await top().isVisible(), "Escape leaves the directory picker open after closing path editing")
  }
  const id = await top().getAttribute("id")
  assert.ok(id)
  if ((await top().getAttribute("data-component")) === "popover-content") {
    await page.waitForFunction((element) => element?.contains(document.activeElement), await top().elementHandle())
  }
  await page.keyboard.press("Escape")
  await page.locator(`[id="${id}"]`).waitFor({ state: "hidden" })
}
async function shot(options: Parameters<typeof page.screenshot>[0]) {
  await settle()
  return page.screenshot(options)
}
async function open(scope = "home") {
  await page.goto(route(scope))
  await editor.waitFor()
}
async function settings() {
  await picker.click()
  await top().getByRole("button", { name: "项目设置", exact: true }).click()
  await top().getByRole("textbox", { name: "项目名称", exact: true }).waitFor()
  await page.waitForFunction(() => {
    const close = document.querySelector<HTMLButtonElement>(".project-settings-dialog .project-icon-button")
    return close && !close.disabled
  })
}
async function folderPath(value: string) {
  const field = top().getByRole("textbox", { name: "文件夹路径", exact: true })
  if (!(await field.count())) await top().getByRole("button", { name: "编辑路径", exact: true }).click()
  await field.fill(value)
  await field.press("Enter")
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
        /正在加载文件夹|Loading folders/.test(el.textContent ?? ""),
      ),
  )
  if (!(await top().getByRole("alert").count())) await field.waitFor({ state: "detached" })
}
async function selectFolder(name: string) {
  const checkbox = page.getByRole("checkbox", { name: `选择文件夹：${name}`, exact: true })
  await top()
    .locator('[data-component="checkbox"]')
    .filter({ has: checkbox })
    .locator('[data-slot="checkbox-checkbox-control"]')
    .click()
  assert.equal(await checkbox.isChecked(), true)
}
async function createForm() {
  await picker.click()
  await top().getByRole("button", { name: "新建项目", exact: true }).click()
  await top().getByRole("textbox", { name: "项目名称", exact: true }).waitFor()
}
async function submit(message: string) {
  await editor.fill(message)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  await page.waitForURL(/\/session\/ses_/)
  check((await page.locator(".session-work-context").count()) === 0, "accepted Session removes the whole setup strip")
  await page.getByText("已收到测试任务。", { exact: false }).first().waitFor()
  check((await page.locator(".session-work-context").count()) === 0, "completed Session keeps setup hidden")
  return page.url().split("/").at(-1)!
}
try {
  await open()
  const contextText = await page.locator(".session-work-context").innerText()
  check(
    !/Workspace|Environment|使用配置的默认值|此 Mac/.test(contextText),
    "Web shows connection identity without internal selectors",
  )
  await editor.fill("创建项目后保留的草稿")
  await createForm()
  check(await top().getByRole("button", { name: "创建项目", exact: true }).isDisabled(), "name and folder are required")
  await shot({ path: path.join(output, "create-empty.png") })
  await top().getByRole("button", { name: "选择文件夹", exact: true }).click()
  await folderPath(fixture)
  for (const name of ["frontend", "backend", "docs"]) await selectFolder(name)
  await top().getByRole("button", { name: "使用选中的文件夹", exact: true }).click()
  check(
    (await top().getByRole("textbox", { name: "项目名称", exact: true }).inputValue()) === "frontend",
    "first folder suggests untouched project name",
  )
  const projectName = "多目录验收 " + stamp
  await top().getByRole("textbox", { name: "项目名称", exact: true }).fill(projectName)
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".project-submit")?.disabled)
  check((await top().locator(".project-folder-row").count()) === 3, "three selected folders remain in the form")
  await shot({ path: path.join(output, "create-folders.png") })
  await top().getByRole("button", { name: "创建项目", exact: true }).click()
  await page.waitForURL((value) => value.pathname !== "/aG9tZQ/session")
  await editor.waitFor()
  check((await editor.innerText()) === "创建项目后保留的草稿", "project creation preserves draft")
  await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true")
  checks.push("creation returns focus to composer")
  const scopeID = Buffer.from(new URL(page.url()).pathname.split("/")[1]!, "base64url").toString()
  const initial = (await client.project.directories({ scopeID }, options)).data
  check(
    initial.folders.length === 3 &&
      initial.folders.find((f) => f.workspaceID === initial.mainWorkspaceID)?.path === folders[0],
    "first selected folder is the real main binding",
  )
  check(
    (await client.project.taskDefaults.get({ scopeID }, options)).data.effective.defaultSessionWorkspace === "main",
    "new projects default to main",
  )
  const resourceBefore = (await client.environment.list({ scopeID }, options)).data
  const workspaceBefore = (await client.workspace.list({ scopeID }, options)).data
  await page.locator("[data-worktree-task-selector]").click()
  check((await top().innerText()).includes("其他 2 个文件夹"), "Worktree choice explains shared folders")
  await top()
    .getByRole("button", { name: /^新建 Worktree/ })
    .click()
  check(
    JSON.stringify((await client.workspace.list({ scopeID }, options)).data) === JSON.stringify(workspaceBefore),
    "selecting Worktree does not create files",
  )
  check(
    JSON.stringify((await client.environment.list({ scopeID }, options)).data) === JSON.stringify(resourceBefore),
    "previewing choices does not allocate compute",
  )
  await shot({ path: path.join(output, "worktree-intent.png") })
  const treeSessionID = await submit("验证基于主目录创建 Worktree")
  const treeSession = (await client.session.get({ scopeID, sessionID: treeSessionID }, options)).data
  check(treeSession.workspace?.type === "git_worktree", "first send creates a real Worktree")
  const firstTrees = (await client.project.worktrees({ scopeID }, options)).data
  const firstTree = firstTrees.find((tree) => tree.path === treeSession.workspace?.path)
  check(firstTree?.sourceDirectory === folders[0], "Worktree retains frontend source")
  await shot({ path: path.join(output, "worktree-created.png") })
  await open(scopeID)
  await settings()
  const name = top().getByRole("textbox", { name: "项目名称", exact: true })
  await name.fill("未保存的名称")
  await page.keyboard.press("Escape")
  await top().getByRole("button", { name: "取消", exact: true }).click()
  check((await name.inputValue()) === "未保存的名称", "cancel discard retains settings")
  await name.fill(projectName)
  const filesSection = top().locator(".project-settings-section").nth(1)
  await filesSection
    .locator(".project-folder-row")
    .filter({ hasText: "backend" })
    .getByRole("button", { name: "文件夹操作" })
    .click()
  await top().getByRole("button", { name: "设为主目录", exact: true }).click()
  await filesSection.getByRole("button", { name: "保存", exact: true }).click()
  await filesSection.getByRole("status").waitFor()
  const updated = (await client.project.directories({ scopeID }, options)).data
  check(
    updated.folders.find((f) => f.workspaceID === updated.mainWorkspaceID)?.path === folders[1],
    "settings changes the actual main folder",
  )
  check(
    (await client.session.get({ scopeID, sessionID: treeSessionID }, options)).data.workspace?.path === firstTree?.path,
    "changing main preserves old task location",
  )
  check(
    (await client.project.worktrees({ scopeID }, options)).data.some(
      (tree) => tree.path === firstTree?.path && tree.sourceDirectory === folders[0],
    ),
    "historical Worktree remains listed with original source",
  )
  await shot({ path: path.join(output, "settings-main-changed.png") })
  await close()
  const mainSessionID = await submit("验证新任务使用 backend 主目录")
  check(
    (await client.session.get({ scopeID, sessionID: mainSessionID }, options)).data.workspace?.path === folders[1],
    "next task uses changed main folder",
  )
  await open(scopeID)
  await page.locator("[data-worktree-task-selector]").click()
  await top()
    .getByRole("button", { name: /^新建 Worktree/ })
    .click()
  const secondTreeSessionID = await submit("验证新 Worktree 使用 backend")
  const secondSession = (await client.session.get({ scopeID, sessionID: secondTreeSessionID }, options)).data
  check(
    (await client.project.worktrees({ scopeID }, options)).data.some(
      (tree) => tree.path === secondSession.workspace?.path && tree.sourceDirectory === folders[1],
    ),
    "new Worktree uses changed source",
  )
  await open(scopeID)
  await editor.fill("目标草稿")
  await open()
  await editor.fill("当前草稿")
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
    await page.locator('input[type="file"]').setInputFiles({
      name: "project-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Project attachment fixture"),
    })
    await uploading
    check(await picker.isDisabled(), "project switching waits for uploads to finish")
  } finally {
    releaseUpload()
  }
  await page.getByText("project-attachment.txt", { exact: true }).first().waitFor()
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-project-task-selector]")?.disabled)
  await picker.click()
  await top().getByRole("textbox", { name: "搜索项目", exact: true }).fill(projectName)
  await top()
    .getByRole("button", { name: new RegExp(projectName) })
    .click()
  await top().getByRole("button", { name: "取消", exact: true }).click()
  check((await editor.innerText()) === "当前草稿", "merge cancellation retains source draft")
  await picker.click()
  await top().getByRole("textbox", { name: "搜索项目", exact: true }).fill(projectName)
  await top()
    .getByRole("button", { name: new RegExp(projectName) })
    .click()
  await top()
    .getByRole("button", { name: /合并并切换/ })
    .click()
  await page.waitForURL(route(scopeID))
  check(
    (await editor.innerText()).replace(/\u200b/g, "") === "目标草稿\n\n当前草稿",
    "draft merge keeps destination before source",
  )
  check(
    await page.getByText("project-attachment.txt", { exact: true }).first().isVisible(),
    "attachment survives merge",
  )
  await settings()
  await top().getByRole("button", { name: "添加文件夹", exact: true }).click()
  await folderPath(directoryFixture)
  await top()
    .getByRole("button", { name: /加载更多文件夹/ })
    .click()
  await page.waitForFunction(() => document.querySelectorAll(".directory-navigation-entry").length >= 120)
  checks.push("service browser loads real pagination")
  await selectFolder("folder-000")
  await selectFolder("folder-119")
  check(
    (await top().locator(".directory-navigation-entry").getByRole("checkbox", { checked: true }).count()) === 2,
    "folder multi-selection spans directory pages",
  )
  await shot({ path: path.join(output, "directory-multiple.png") })
  await top().getByText("显示隐藏文件夹", { exact: true }).click()
  await top().getByRole("button", { name: ".hidden-folder", exact: true }).waitFor()
  checks.push("hidden folders become available without discarding selection")
  const search = top().getByRole("textbox", { name: "搜索当前目录下的文件夹", exact: true })
  await search.fill("no-such-folder-for-acceptance")
  await search.press("Enter")
  await top().locator(".directory-navigation-empty").waitFor()
  check(
    /没有匹配|No matching/.test(await top().locator(".directory-navigation-empty").innerText()),
    "empty search has a distinct result",
  )
  await search.fill("")
  await folderPath(path.join(directoryFixture, "missing"))
  await top().getByRole("alert").waitFor()
  check(
    (await top().getByRole("textbox", { name: "文件夹路径" }).inputValue()).endsWith("missing"),
    "directory error retains attempted path",
  )
  const denied = path.join(fixture, "restricted")
  await mkdir(denied, { recursive: true })
  await chmod(denied, 0)
  try {
    await folderPath(denied)
    await top().getByRole("alert").waitFor()
    check(
      /权限|permissions/.test(await top().getByRole("alert").innerText()),
      "directory permission failure is distinguished from a missing path",
    )
    await shot({ path: path.join(output, "directory-permission.png") })
  } finally {
    await chmod(denied, 0o700)
  }
  await top()
    .getByRole("button", { name: /^(重试|Retry)$/ })
    .click()
  await top().locator(".directory-navigation-empty").waitFor()
  check(
    /没有子文件夹|no subfolders/.test(await top().locator(".directory-navigation-empty").innerText()),
    "directory retry recovers the same path after access is restored",
  )
  await close()
  await close()
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [width, height] of [
      [1440, 900],
      [800, 700],
      [375, 740],
      [1440, 480],
      [720, 450],
    ]) {
      await page.setViewportSize({ width: width!, height: height! })
      const label = `${colorScheme}-${width}x${height}`
      await picker.click()
      await shot({ path: path.join(output, label + "-menu.png") })
      const bounds = (await top().boundingBox())!
      check(
        bounds.x >= -1 &&
          bounds.y >= -1 &&
          bounds.x + bounds.width <= width! + 1 &&
          bounds.y + bounds.height <= height! + 1,
        label + ": project menu fits",
      )
      if (width! >= 640) check(Math.abs(bounds.width - 360) <= 1, label + ": project menu uses the intended width")
      await close()
      await settings()
      await shot({ path: path.join(output, label + "-settings.png") })
      const actions = (await top().locator('[data-slot="dialog-actions"]').boundingBox())!
      check(actions.y >= 0 && actions.y + actions.height <= height! + 1, label + ": settings actions remain visible")
      if (colorScheme === "light" && width === 1440 && height === 900) {
        await top().locator("span.project-folder-name").first().focus()
        await page.locator('[data-component="tooltip"][data-expanded]').waitFor()
        await page.keyboard.press("Escape")
        await page.waitForFunction(() => !document.querySelector('[data-component="tooltip"][data-expanded]'))
        check(await top().isVisible(), "Escape closes the focused path tooltip before its parent dialog")
      }
      await close()
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-project-task-selector"))
      checks.push(label + ": settings returns focus to project trigger")
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const normal = (await picker.boundingBox())!
  await picker.hover()
  const hover = (await picker.boundingBox())!
  await picker.focus()
  const focused = (await picker.boundingBox())!
  check(
    [hover, focused].every((rect) => Math.abs(rect.x - normal.x) <= 1 && Math.abs(rect.y - normal.y) <= 1),
    "project trigger remains fixed on hover and focus",
  )
  await picker.click()
  await close()
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-project-task-selector"))
  check(await picker.evaluate((element) => document.activeElement === element), "Escape restores project trigger focus")
  for (const [kind, endpoint] of [
    ["managed", desktopEndpoint],
    ["external", externalDesktopEndpoint],
  ] as const) {
    if (!endpoint) continue
    const desktop = await chromium.connectOverCDP(endpoint)
    try {
      const nativePage = desktop
        .contexts()[0]!
        .pages()
        .find((candidate) => candidate.url().startsWith(url.origin))!
      assert.ok(nativePage, "Desktop must use the same production origin")
      await nativePage.goto(route(scopeID))
      await nativePage.locator(".session-work-context").waitFor()
      const computer = await nativePage.locator(".session-work-context").innerText()
      check(
        kind === "managed"
          ? /此 Mac|This Mac/.test(computer)
          : !/此 Mac|This Mac/.test(computer) && computer.includes(url.host),
        `${kind} Desktop identifies its actual computer`,
      )
      await nativePage.locator("[data-project-task-selector]").click()
      await nativePage.getByRole("button", { name: /^(新建项目|New project)$/ }).click()
      const name = nativePage.getByRole("textbox", { name: /^(项目名称|Project name)$/ })
      await name.waitFor()
      await nativePage.screenshot({ animations: "disabled", path: path.join(output, `desktop-${kind}-create.png`) })
      if (kind === "external") {
        await name.fill("External Desktop draft")
        await nativePage.locator(".project-folder-empty").click()
        const browser = nativePage.locator(".directory-navigation")
        await browser.waitFor()
        check(
          !!(await browser.getByRole("textbox", { name: /^(文件夹路径|Folder path)$/ }).inputValue()),
          "external Desktop localhost opens the service directory browser",
        )
        await nativePage.screenshot({
          animations: "disabled",
          path: path.join(output, "desktop-external-directory.png"),
        })
        await nativePage.keyboard.press("Escape")
        await browser.waitFor({ state: "hidden" })
        check(
          (await name.inputValue()) === "External Desktop draft",
          "external Desktop folder cancel preserves the parent form",
        )
        await name.fill("")
      }
      await nativePage.keyboard.press("Escape")
      await nativePage.locator(".project-create-dialog").waitFor({ state: "hidden" })
      await nativePage.waitForFunction(() => document.activeElement?.hasAttribute("data-project-task-selector"))
      checks.push(`${kind} Desktop uses the same-build form and restores trigger focus`)
    } finally {
      await desktop.close()
    }
  }
  check(errors.length === 0, "no renderer page errors")
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        checks,
        timeline,
        errors,
        scopeID,
        sessions: [treeSessionID, mainSessionID, secondTreeSessionID],
        viewportNote:
          "720x450 checks the effective layout viewport at 200%; native zoom and OS picker are separate checks.",
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ output, checks: checks.length, errors }))
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), timeout: 5000 })
  await writeFile(
    path.join(output, "failure.txt"),
    String(error) + "\n" + (await page.locator("body").innerText()) + "\n" + errors.join("\n"),
  )
  throw error
} finally {
  await context.close()
  await browser.close()
}
