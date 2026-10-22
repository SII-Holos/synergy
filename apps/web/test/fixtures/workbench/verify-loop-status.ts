import assert from "node:assert/strict"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { chromium } from "playwright"

const [home, origin, out] = process.argv.slice(2)
assert.ok(home && origin && out, "Usage: verify-loop-status.ts <isolated-home> <origin> <output>")
assert.equal(new URL(origin).hostname, "127.0.0.1")
assert.notEqual(await realpath(home), await realpath(homedir()))
await mkdir(out, { recursive: true })
const client = createSynergyClient({ baseUrl: origin }),
  options = { throwOnError: true } as const
assert.equal(await realpath((await client.path.get({ scopeID: "home" }, options)).data.home), await realpath(home))
type Gate = {
  finish(text?: string): void
  tool(name: string, args: object): void
  abort(): void
  append(text: string): void
}
const lightGoal = "修复后台会话结束后最终回复缺失，保留历史阅读位置，并验证切换会话不重复拉取正文。"
const revisedLightGoal = "修复后台会话结束后最终回复缺失，并补齐断线重连、失败和取消任务的回归测试。"
const blueprintTitle = "消息流稳定性：历史加载、后台生成与会话切换"
let current:
  | {
      kind: "lightloop" | "blueprint"
      id: string
      title: string
      stopped: boolean
      approved: boolean
      reviewAnswered: boolean
      failReview: boolean
    }
  | undefined
const gates = new Map<string, Gate>(),
  records: object[] = [],
  owned: string[] = []
const wait = async (fn: () => boolean | Promise<boolean>, label: string) => {
  const end = Date.now() + 120000
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Timed out: " + label)
    await Bun.sleep(100)
  }
}
const inference = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const input = (await request.json()) as {
      model: string
      stream?: boolean
      messages: { role: string; content: unknown }[]
      tools?: { function: { name: string; parameters: unknown } }[]
    }
    if (input.model === "aux" || !current)
      return Response.json({
        id: "aux",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "界面状态验收" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    const names = input.tools?.map((t) => t.function.name) ?? []
    const review = names.includes("blueprint_loop_approve")
    if (review && current.failReview)
      return Response.json(
        {
          error: {
            message: "Controlled reviewer failure",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        },
        { status: 400 },
      )
    const key = review ? "review" : "execute",
      afterTool = input.messages.at(-1)?.role === "tool"
    console.log(
      JSON.stringify({
        request: key,
        afterTool,
        approved: current.approved,
        tools: names.filter((n) => n.includes("loop")),
      }),
    )
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          let closed = false
          const send = (delta: object, finish_reason: string | null = null) => {
            if (!closed)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "display-" + Date.now(), object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                ),
              )
          }
          const close = () => {
            if (closed) return
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
            closed = true
            gates.delete(key)
          }
          const gate: Gate = {
            append(text) {
              send({ content: text })
            },
            finish(text = "本阶段已完成。") {
              send({ content: text })
              send({}, "stop")
              close()
            },
            tool(name, args) {
              send({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_" + Date.now(),
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              })
              send({}, "tool_calls")
              close()
            },
            abort() {
              try {
                close()
              } catch {
                closed = true
                gates.delete(key)
              }
            },
          }
          send({ role: "assistant" })
          if (
            !names.some((name) => ["loop_stop", "blueprint_loop_stop", "blueprint_loop_approve"].includes(name)) ||
            afterTool ||
            current?.approved ||
            (review && current?.reviewAnswered) ||
            (!review && current?.stopped)
          ) {
            gate.finish(
              current?.kind === "lightloop"
                ? "任务验收完成。"
                : current?.approved
                  ? "独立审核已经通过，状态验收完成。"
                  : "执行阶段已结束，等待独立审核。",
            )
            return
          }
          send({ content: review ? "正在独立审核本次验收结果。" : "正在执行本次界面状态验收任务。" })
          gates.set(key, gate)
          request.signal.addEventListener(
            "abort",
            () => {
              closed = true
              if (gates.get(key) === gate) gates.delete(key)
            },
            { once: true },
          )
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})
await client.config.domain.update(
  {
    domain: "providers",
    configDomainUpdateInput: {
      config: {
        enabled_providers: ["loop-ui"],
        provider: {
          "loop-ui": {
            name: "UI 状态验收模型",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { baseURL: inference.url.origin + "/v1", apiKey: "fixture-only" },
            models: {
              main: { name: "UI 状态验收模型", tool_call: true, limit: { context: 128000, output: 8192 } },
              aux: { name: "UI 验收辅助", tool_call: true, limit: { context: 128000, output: 8192 } },
            },
          },
        },
      },
    },
  },
  options,
)
await client.config.domain.update(
  {
    domain: "models",
    configDomainUpdateInput: {
      config: {
        model: "loop-ui/main",
        nano_model: "loop-ui/aux",
        mini_model: "loop-ui/aux",
        mid_model: "loop-ui/main",
      },
    },
  },
  options,
)
await client.config.domain.update(
  {
    domain: "agents",
    configDomainUpdateInput: {
      config: {
        agent: {
          pico: { model: "loop-ui/main" },
          supervisor: { model: "loop-ui/main" },
        },
      },
    },
  },
  options,
)
const bodyReads: string[] = [],
  statusReads: string[] = []
let socketBytes = 0
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", locale: "zh-CN" })
await page.addInitScript(() => {
  const tracked = window as typeof window & { loopStages: string[] }
  tracked.loopStages = []
  new MutationObserver(() => {
    for (const row of document.querySelectorAll("[data-component=loop-status-entry]"))
      tracked.loopStages.push(row.getAttribute("data-stage") ?? "unknown")
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-stage"] })
})
page.on("request", (r) => {
  const path = new URL(r.url()).pathname
  if (/\/(?:display|message)\//.test(path)) bodyReads.push(path)
  if (r.method() === "GET" && (/\/lightloop\/terminal$/.test(path) || /\/blueprint\/loop\/[^/]+$/.test(path)))
    statusReads.push(path)
})
page.on("websocket", (socket) =>
  socket.on("framereceived", (event) => {
    socketBytes += typeof event.payload === "string" ? Buffer.byteLength(event.payload) : event.payload.length
  }),
)
const pageErrors: string[] = []
page.on("pageerror", (e) => pageErrors.push(e.message))
async function capture(label: string, completed = false) {
  await page.waitForTimeout(650)
  await page.getByText(/正在加载对话|Loading conversation/).waitFor({ state: "hidden", timeout: 45000 })
  const state = page.locator('[data-component="loop-status-entry"] [role="status"]')
  if (await state.count())
    assert.ok(await state.evaluate((node) => node.scrollWidth <= node.clientWidth), "Loop status stays readable")
  if (completed) assert.equal(await page.locator("[data-component=loop-status-entry]").count(), 0)
  const session = current
    ? (await client.session.get({ scopeID: "home", sessionID: current.id }, options)).data
    : undefined
  if (current && !completed) {
    const label = page.locator('[data-component="loop-status-entry"] .pending-composer-label')
    assert.equal(await label.textContent(), current.title, "The row identifies the Loop goal or Blueprint note")
    assert.equal(await label.getAttribute("title"), current.title, "The complete label remains available on hover")
    assert.equal(await label.evaluate((node) => getComputedStyle(node).textOverflow), "ellipsis")
    if (page.viewportSize()!.width <= 375)
      assert.ok(
        await label.evaluate((node) => node.scrollWidth > node.clientWidth),
        "Long labels truncate in narrow panes",
      )
  }
  const snapshot = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll("button")]
      .filter((b) => b.checkVisibility())
      .map((b) => ({ text: b.innerText, label: b.getAttribute("aria-label"), title: b.getAttribute("title") })),
    composer: document.querySelector(".prompt-input")?.textContent,
    text: document.body.innerText,
  }))
  await page.screenshot({ path: out + "/" + label + ".png" })
  await Bun.write(out + "/" + label + ".json", JSON.stringify({ label, session, snapshot }, null, 2))
  records.push({
    label,
    workflow: session?.workflow,
    blueprint: session?.blueprint,
    loopVisible: (await state.count()) > 0,
    bodyReads: bodyReads.length,
    statusReads: statusReads.length,
    socketBytes,
  })
  console.log(
    JSON.stringify({ captured: label, workflow: session?.workflow?.kind, blueprint: session?.blueprint?.phase }),
  )
}
async function openDetails(label: string, completed = false) {
  const candidates = page.getByRole("button", { name: /^任务详情$|^Task details$/ })
  if (await candidates.count()) {
    await candidates.first().click()
    await capture(label, completed)
    await candidates.first().click()
  } else console.log(JSON.stringify({ detailsButtons: await page.getByRole("button").allTextContents() }))
}
async function verifyCompletedNavigation(session: { id: string; title: string }, peer: { id: string; title: string }) {
  const kind = current!.kind
  const finalText = kind === "lightloop" ? "任务验收完成。" : "独立审核已经通过，状态验收完成。"
  await page.getByText(finalText, { exact: true }).first().waitFor({ timeout: 60000 })
  await page.locator("[data-component=loop-status-entry]").waitFor({ state: "detached" })
  await capture(kind + "-completed", true)
  await page.evaluate(() => ((window as typeof window & { loopStages: string[] }).loopStages = []))
  const before = statusReads.length
  await page.getByText(peer.title, { exact: true }).first().click()
  await page.waitForURL(origin + "/aG9tZQ/session/" + peer.id)
  await page.getByText(session.title, { exact: true }).first().click()
  await page.waitForURL(origin + "/aG9tZQ/session/" + session.id)
  await page.getByText(finalText, { exact: true }).first().waitFor()
  await capture(kind + "-completed-return", true)
  assert.equal(statusReads.length, before, "Returning to a completed Loop reuses its retained status")
  assert.deepEqual(
    await page.evaluate(() => (window as typeof window & { loopStages: string[] }).loopStages),
    [],
    "Completed status never flashes back when switching sessions",
  )
  const terminalRead = page.waitForResponse(
    (response) =>
      response.ok() &&
      (kind === "lightloop"
        ? new URL(response.url()).pathname.endsWith("/lightloop/terminal")
        : /\/blueprint\/loop\/[^/]+$/.test(new URL(response.url()).pathname)),
  )
  await page.reload()
  await terminalRead
  await page.getByText(finalText, { exact: true }).first().waitFor({ timeout: 60000 })
  await capture(kind + "-completed-reload", true)
  assert.deepEqual(
    await page.evaluate(() => (window as typeof window & { loopStages: string[] }).loopStages),
    [],
    "Completed status never flashes back during cold history restoration",
  )
  await page.setViewportSize({ width: 375, height: 900 })
  await capture(kind + "-completed-narrow", true)
  await page.emulateMedia({ colorScheme: "dark" })
  await capture(kind + "-completed-narrow-dark", true)
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 1440, height: 1000 })
}
try {
  const peer = (await client.session.create({ scopeID: "home", title: "Loop status peer " + Date.now() }, options)).data
  owned.push(peer.id)
  for (const kind of (process.env.LOOP_KIND ? [process.env.LOOP_KIND] : ["lightloop", "blueprint"]) as (
    "lightloop" | "blueprint"
  )[]) {
    for (const outcome of (["approve", "failed", "cancelled", "cancel-review"] as const).filter(
      (outcome) =>
        (kind === "blueprint" || outcome === "approve" || outcome === "cancelled") &&
        (!process.env.LOOP_OUTCOME || outcome === process.env.LOOP_OUTCOME),
    )) {
      const session = (
        await client.session.create(
          {
            scopeID: "home",
            title: `${kind === "lightloop" ? "Light Loop" : "BlueprintLoop"} · ${outcome} · ${Date.now()}`,
            controlProfile: "full_access",
          },
          options,
        )
      ).data
      current = {
        kind,
        id: session.id,
        title: kind === "lightloop" ? lightGoal : blueprintTitle,
        stopped: false,
        approved: false,
        reviewAnswered: false,
        failReview: outcome === "failed",
      }
      owned.push(session.id)
      await page.goto(origin + "/aG9tZQ/session/" + session.id)
      await page.getByRole("textbox", { name: /发送消息|Send message/ }).waitFor({ timeout: 60000 })
      let loopID: string | undefined
      if (kind === "lightloop") {
        await client.workflow.session.set(
          {
            id: session.id,
            scopeID: "home",
            workflowSetInput: { kind: "lightloop", instructions: lightGoal },
          },
          options,
        )
        await page.locator("[data-component=loop-status-entry][data-stage=bound]").waitFor()
        await capture("lightloop-" + outcome + "-01-bound")
        await client.session.input(
          {
            sessionID: session.id,
            scopeID: "home",
            agent: "pico",
            model: { providerID: "loop-ui", modelID: "main" },
            parts: [{ type: "text", text: "开始状态展示验收。" }],
          },
          options,
        )
      } else {
        const note = (
          await client.note.create(
            {
              scopeID: "home",
              noteCreateInput: {
                kind: "blueprint",
                title: blueprintTitle,
                content: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "检查绑定、执行、审核及完成阶段的状态展示。" }],
                    },
                  ],
                },
                blueprint: { defaultAgent: "pico" },
              },
            },
            options,
          )
        ).data
        const loop = (
          await client.blueprint.loop.create(
            {
              scopeID: "home",
              blueprintLoopCreateInput: {
                noteID: note.id,
                title: note.title,
                sessionID: session.id,
                executionAgent: "pico",
                runMode: "current",
                model: { providerID: "loop-ui", modelID: "main" },
              },
            },
            options,
          )
        ).data
        loopID = loop.id
        await client.blueprint.loop.bind({ id: loop.id, scopeID: "home", sessionID: session.id }, options)
        await page.locator("[data-component=loop-status-entry][data-stage=bound]").waitFor()
        await capture("blueprint-" + outcome + "-01-bound")
        await client.blueprint.loop.start({ id: loop.id, scopeID: "home" }, options)
      }
      await wait(() => gates.has("execute"), "execution stream")
      await capture(kind + "-" + outcome + "-02-running")
      assert.equal(await page.locator("[data-component=loop-status-entry]").getAttribute("data-stage"), "running")
      if (outcome === "approve") {
        const before = statusReads.length
        const beforeBodies = bodyReads.length
        await page.getByText(peer.title, { exact: true }).first().click()
        await page.waitForURL(origin + "/aG9tZQ/session/" + peer.id)
        await page.getByText(session.title, { exact: true }).first().click()
        await page.waitForURL(origin + "/aG9tZQ/session/" + session.id)
        await page.locator("[data-component=loop-status-entry][data-stage=running]").waitFor()
        await capture(kind + "-warm-return")
        assert.equal(statusReads.length, before, "Warm return must reuse Loop state without status requests")
        assert.equal(bodyReads.length, beforeBodies, "Warm return must not reload unchanged message bodies")
      }
      if (outcome === "approve") {
        for (const text of ["检查队列图标操作", "保留消息附件与草稿"])
          assert.equal(
            (
              await client.session.input(
                { sessionID: session.id, scopeID: "home", parts: [{ type: "text", text }] },
                options,
              )
            ).data.status,
            "queued",
          )
        const queue = page.locator(".pending-composer-queue")
        await queue.locator("[data-slot=pending-timeline-item]").nth(1).waitFor()
        assert.equal(await page.locator(".prompt-input-shell [data-component=loop-status-entry]").count(), 0)
        await capture(kind + "-queue-stack")
        await page.setViewportSize({ width: 375, height: 900 })
        await capture(kind + "-queue-stack-narrow")
        await page.emulateMedia({ colorScheme: "dark" })
        await capture(kind + "-queue-stack-dark")
        await page.emulateMedia({ colorScheme: "light" })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await queue
          .getByRole("button", { name: /^引导$|^Guide$/ })
          .first()
          .click()
        await queue.locator('[data-mode="steer"]').waitFor()
        await queue
          .getByRole("button", { name: /^编辑消息$|^Edit message$/ })
          .last()
          .click()
        const editor = page.getByRole("textbox", { name: /发送消息|Send message/ })
        await wait(async () => (await editor.innerText()).includes("保留消息附件与草稿"), "queue edit restores draft")
        await capture(kind + "-queue-edited")
        await editor.fill("")
        await queue.getByRole("button", { name: /^删除$|^Delete$/ }).click()
        await queue.waitFor({ state: "detached" })
        assert.ok(await page.locator("[data-component=loop-status-entry]").isVisible())
      }
      if (outcome === "cancelled") {
        await page
          .locator("[data-component=loop-status-entry]")
          .getByRole("button", { name: /取消本次循环|Cancel loop/ })
          .click()
        gates.get("execute")?.abort()
        await page.locator("[data-component=loop-status-entry][data-stage=cancelled]").waitFor({ timeout: 60000 })
        await capture(kind + "-cancelled")
        continue
      }
      await client.session.abort({ sessionID: session.id, scopeID: "home" }, options)
      gates.get("execute")?.abort()
      await page.locator("[data-component=loop-status-entry][data-stage=paused]").waitFor()
      await capture(kind + "-" + outcome + "-03-paused")
      if (kind === "lightloop" && outcome === "approve") {
        await page
          .locator("[data-component=loop-status-entry]")
          .getByRole("button", { name: /编辑目标|Edit goal/ })
          .click()
        await page.getByRole("dialog").getByRole("textbox").fill(revisedLightGoal)
        await capture("lightloop-edit-goal")
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /保存任务|Save task/ })
          .click()
        await page.getByRole("dialog").waitFor({ state: "hidden" })
        assert.equal(
          (await client.session.get({ sessionID: session.id, scopeID: "home" }, options)).data.workflow?.kind,
          "lightloop",
        )
        const updated = (await client.session.get({ sessionID: session.id, scopeID: "home" }, options)).data.workflow
        assert.ok(updated?.kind === "lightloop" && updated.instructions === revisedLightGoal)
        current.title = revisedLightGoal
      }
      void client.session
        .continue({ sessionID: session.id, scopeID: "home" }, options)
        .catch((error) => console.log(JSON.stringify({ continueError: String(error) })))
      await wait(() => gates.has("execute"), "resumed stream")
      await page.locator("[data-component=loop-status-entry][data-stage=running]").waitFor()
      await capture(kind + "-" + outcome + "-04-resumed")
      current.stopped = true
      gates.get("execute")!.tool(kind === "lightloop" ? "loop_stop" : "blueprint_loop_stop", {
        summary: "本轮界面状态验收与截图已完成。",
      })
      if (kind === "lightloop") {
        await verifyCompletedNavigation(session, peer)
        const terminal = (
          await client.workflow.session.getLightloopTerminal({ id: session.id, scopeID: "home" }, options)
        ).data
        assert.equal(terminal.status, "completed")
        assert.equal(terminal.instructions, revisedLightGoal)
        continue
      }
      if (outcome === "failed") {
        await page.locator("[data-component=loop-status-entry][data-stage=failed]").waitFor({ timeout: 120000 })
        await capture(kind + "-failed")
        await page.locator("[data-component=loop-status-entry] [data-action=loop-details]").click()
        await capture(kind + "-failed-details")
        await page.keyboard.press("Escape")
        await page.reload()
        await page.locator("[data-component=loop-status-entry][data-stage=failed]").waitFor({ timeout: 60000 })
        await capture(kind + "-reload-failed")
        continue
      }
      await wait(() => gates.has("review"), "review stream")
      await capture(kind + "-05-auditing")
      if (outcome === "cancel-review") {
        const children = (await client.session.children({ sessionID: session.id, scopeID: "home" }, options)).data.items
        const childSessions = await Promise.all(
          children.map(
            async (child) => (await client.session.get({ sessionID: child.id, scopeID: "home" }, options)).data,
          ),
        )
        assert.ok(childSessions.some((child) => child.cortex?.status === "running"))
        await page
          .locator("[data-component=loop-status-entry]")
          .getByRole("button", { name: /取消本次循环|Cancel loop/ })
          .click()
        gates.get("review")?.abort()
        await page.locator("[data-component=loop-status-entry][data-stage=cancelled]").waitFor({ timeout: 60000 })
        for (const child of children) {
          const stopped = (await client.session.get({ sessionID: child.id, scopeID: "home" }, options)).data
          assert.ok(!["queued", "running"].includes(stopped.cortex?.status ?? ""))
        }
        await capture(kind + "-cancel-review")
        continue
      }
      await openDetails(kind + "-06-task-details")
      current.reviewAnswered = true
      current.stopped = false
      gates.get("review")!.tool("blueprint_loop_reject", {
        reason: "缺少取消和失败路径的回归证据；补齐失败与取消场景，完成回归后重新申请审核。",
      })
      await wait(() => gates.has("execute"), "rework stream")
      await page.locator("[data-component=loop-status-entry][data-stage=rework]").waitFor({ timeout: 60000 })
      await capture(kind + "-rework")
      await page.locator("[data-component=loop-status-entry] [data-action=loop-details]").click()
      await capture(kind + "-rework-details")
      await page.keyboard.press("Escape")
      assert.notEqual(
        (await client.session.get({ sessionID: session.id, scopeID: "home" }, options)).data.paused?.reason,
        "aborted",
      )
      current.stopped = true
      current.reviewAnswered = false
      gates.get("execute")!.tool("blueprint_loop_stop", {
        summary: "失败与取消回归已补齐，验收截图已保存，重新申请审核。",
      })
      await wait(() => gates.has("review"), "second review stream")
      await capture(kind + "-review-after-rework")
      await page
        .locator("[data-component=loop-status-entry]")
        .getByRole("button", { name: /^打开蓝图$|^Open Blueprint$/ })
        .click()
      await page
        .locator(".note-blueprint-state")
        .filter({ hasText: /审核中|Reviewing/ })
        .waitFor()
      const beforeApproval = statusReads.length
      current.approved = true
      current.reviewAnswered = true
      gates.get("review")!.tool("blueprint_loop_approve", {
        summary: "受控验收任务已完成。",
      })
      await wait(async () => {
        const s = (await client.session.get({ sessionID: session.id, scopeID: "home" }, options)).data
        return !s.blueprint?.loopID
      }, "approval transition")
      await wait(async () => {
        const s = (await client.session.statuses(options)).data[session.id]
        return !s || (s.type !== "busy" && s.type !== "retry")
      }, "completion settled")
      await page.waitForTimeout(1200)
      await page
        .locator(".note-blueprint-state")
        .filter({ hasText: /审核通过|Review passed/ })
        .waitFor({ timeout: 60000 })
      await capture("blueprint-note-completed", true)
      assert.equal(statusReads.length - beforeApproval, 0, "Approval must not repeat status reads")
      await page.emulateMedia({ colorScheme: "dark" })
      await capture("blueprint-note-completed-dark", true)
      await page.emulateMedia({ colorScheme: "light" })
      await verifyCompletedNavigation(session, peer)
      await page
        .locator(".note-blueprint-state")
        .filter({ hasText: /审核通过|Review passed/ })
        .waitFor()
      const completedLoop = (await client.blueprint.loop.get({ id: loopID!, scopeID: "home" }, options)).data
      assert.equal(completedLoop.status, "completed")
      assert.equal(completedLoop.summary, "受控验收任务已完成。")
      await page
        .locator(".workbench-surface-tab")
        .filter({ hasText: blueprintTitle })
        .locator(".workbench-surface-tab-close")
        .click()
      await capture("blueprint-completed-conversation", true)
      await openDetails(kind + "-completed-details", true)
    }
  }
  assert.deepEqual(pageErrors, [])
} finally {
  for (const id of owned) {
    const children =
      (await client.session.children({ sessionID: id, scopeID: "home" }, options).catch(() => undefined))?.data.items ??
      []
    for (const child of children)
      await client.session.abort({ sessionID: child.id, scopeID: "home" }, options).catch(() => {})
    await client.session.abandon({ sessionID: id, scopeID: "home" }, options).catch(() => {})
  }
  for (const gate of [...gates.values()]) gate.abort()
  await Bun.write(out + "/summary.json", JSON.stringify(records, null, 2))
  await browser.close()
  inference.stop(true)
}
