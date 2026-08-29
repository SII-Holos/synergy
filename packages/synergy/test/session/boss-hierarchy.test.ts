import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
import { SessionInbox } from "../../src/session/inbox"
import { BossService } from "../../src/boss/boss"
import { BossProjectTool, DEFAULT_PROJECT_BOSS_INSTRUCTIONS } from "../../src/boss/tools/boss-project"
import { SessionSendTool } from "../../src/tool/session-send"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"
import path from "path"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-boss-hierarchy-test",
    agent: "synergy-max",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

describe("boss hierarchy (layered reporting protocol)", () => {
  test("worker boss_report lands only in the project boss history, never the top boss", async () => {
    await withScope(async () => {
      // Top boss (runtime boss, home).
      const top = await Session.create({})
      await SessionWorkflowService.enableBoss(top.id)

      // Project boss in a project scope (as boss_project would create it).
      const projectDir = path.join(process.env.SYNERGY_TEST_ROOT!, "hierarchy-" + Math.random().toString(36).slice(2))
      const tool = await BossProjectTool.init()
      const created = await tool.execute({ directory: projectDir, title: "Project X" }, ctx(top.id))
      const projectBossID = created.metadata.sessionID as string

      // Worker under the project boss.
      const worker = await BossService.spawn(projectBossID, { role: "code" })

      // Worker reports to its direct parent (project boss).
      await BossService.report(worker.id, { summary: "已完成任务,结果见 x.ts", status: "completed", refs: ["x.ts"] })

      // Project boss inbox has the report.
      const projectItems = await SessionInbox.list(projectBossID)
      const reports = projectItems.filter((item) => item.message?.origin?.detail === "boss_report")
      expect(reports).toHaveLength(1)
      expect(reports[0]!.message!.parts?.[0]).toMatchObject({ text: expect.stringContaining("已完成任务") })

      // Top boss inbox has NO worker report.
      const topItems = await SessionInbox.list(top.id)
      expect(topItems.filter((item) => item.message?.origin?.detail === "boss_report")).toHaveLength(0)
    })
  })

  test("project boss sends a summary to the top boss via session_send", async () => {
    await withScope(async () => {
      const top = await Session.create({})
      await SessionWorkflowService.enableBoss(top.id)

      const projectDir = path.join(process.env.SYNERGY_TEST_ROOT!, "hierarchy-" + Math.random().toString(36).slice(2))
      const tool = await BossProjectTool.init()
      const created = await tool.execute({ directory: projectDir, title: "Project Y" }, ctx(top.id))
      const projectBossID = created.metadata.sessionID as string

      // Project boss sends a summary (status + one-line result + sessionID ref).
      const sendTool = await SessionSendTool.init()
      const summary = `Status: completed\n结果: 功能已实现。\n参考: ${projectBossID}`
      await sendTool.execute({ target: top.id, content: summary, role: "user" }, ctx(projectBossID))

      const topItems = await SessionInbox.list(top.id)
      const delivered = topItems.filter((item) => item.message?.metadata?.source === "session_send")
      expect(delivered.length).toBeGreaterThanOrEqual(1)
      const text = delivered[0]!.message!.parts!.map((p) => (p as { text?: string }).text ?? "").join("")
      expect(text).toContain("Status: completed")
      expect(text).toContain("功能已实现")
      expect(text).toContain(projectBossID)
    })
  })

  test("boss_project writes the default layered-reporting discipline into instructions", async () => {
    await withScope(async () => {
      const top = await Session.create({})
      await SessionWorkflowService.enableBoss(top.id)
      const projectDir = path.join(process.env.SYNERGY_TEST_ROOT!, "hierarchy-" + Math.random().toString(36).slice(2))
      const tool = await BossProjectTool.init()
      const created = await tool.execute({ directory: projectDir, title: "Project Z" }, ctx(top.id))
      const projectBoss = await Session.get(created.metadata.sessionID as string)
      expect(projectBoss.workflow?.kind === "boss" && projectBoss.workflow.role).toBe("boss")
      if (projectBoss.workflow?.kind === "boss") {
        expect(projectBoss.workflow.instructions).toContain("分层汇报纪律")
        expect(projectBoss.workflow.instructions).toContain("session_send")
        expect(projectBoss.workflow.instructions).toContain("memory_write")
      }
      expect(DEFAULT_PROJECT_BOSS_INSTRUCTIONS).toContain("分层汇报纪律")
    })
  })
})
