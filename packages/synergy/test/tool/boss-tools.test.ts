import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { BossService } from "../../src/boss/boss"
import { SessionInbox } from "../../src/session/inbox"
import { SessionWorkflowService } from "../../src/session/workflow"
import { BossAssignTool } from "../../src/boss/tools/boss-assign"
import { BossCancelTool } from "../../src/boss/tools/boss-cancel"
import { BossReportTool } from "../../src/boss/tools/boss-report"
import { BossSpawnTool } from "../../src/boss/tools/boss-spawn"
import { BossStatusTool } from "../../src/boss/tools/boss-status"
import { ToolRegistry } from "../../src/tool/registry"
// Product domains register tool providers via the L4 manifest
import "../../src/product-registration"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-boss-test",
    agent: "synergy-max",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function bossAndWorker(): Promise<{ boss: Session.Info; worker: Session.Info }> {
  const boss = await Session.create({})
  await SessionWorkflowService.enableBoss(boss.id)
  const worker = await BossService.spawn(boss.id, { role: "code" })
  return { boss, worker }
}

describe("Boss tools", () => {
  test("registers the five boss tools", async () => {
    await withScope(async () => {
      expect(await ToolRegistry.find("boss_spawn")).toBeDefined()
      expect(await ToolRegistry.find("boss_assign")).toBeDefined()
      expect(await ToolRegistry.find("boss_report")).toBeDefined()
      expect(await ToolRegistry.find("boss_status")).toBeDefined()
      expect(await ToolRegistry.find("boss_cancel")).toBeDefined()
    })
  })

  test("boss_spawn creates a worker and returns its sessionID", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const tool = await BossSpawnTool.init()
      const result = await tool.execute({ role: "review" }, ctx(boss.id))
      expect(result.metadata).toMatchObject({ role: "review" })
      const workerID = result.metadata.sessionID as string
      const worker = await Session.get(workerID)
      expect(worker.workflow).toEqual({
        kind: "boss",
        role: "worker",
        workerRole: "review",
        rootID: boss.id,
      })
    })
  })

  test("boss_assign delivers a task and is idempotent", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const tool = await BossAssignTool.init()
      const first = await tool.execute(
        { sessionID: worker.id, taskID: "task-1", task: "Implement the widget" },
        ctx(boss.id),
      )
      expect(first.metadata).toMatchObject({ sessionID: worker.id, taskID: "task-1", created: true })
      const second = await tool.execute(
        { sessionID: worker.id, taskID: "task-1", task: "Implement the widget" },
        ctx(boss.id),
      )
      expect(second.metadata).toMatchObject({ created: false })
      expect(await SessionInbox.list(worker.id)).toHaveLength(1)
    })
  })

  test("boss_report reports to the parent", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const tool = await BossReportTool.init()
      const result = await tool.execute({ summary: "Done", status: "completed", refs: ["a.ts"] }, ctx(worker.id))
      expect(result.metadata).toMatchObject({ status: "completed" })
      const items = await SessionInbox.list(boss.id)
      expect(items).toHaveLength(1)
      expect(items[0].mode).toBe("steer")
    })
  })

  test("boss_status renders a text tree with the worker count", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t1", task: "do it" })
      const tool = await BossStatusTool.init()
      const result = await tool.execute({}, ctx(boss.id))
      expect(result.metadata).toMatchObject({ workerCount: 1 })
      expect(result.output).toContain(worker.id)
      expect(result.output).toContain("task t1")
    })
  })

  test("boss_cancel removes matching pending inbox items", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t1", task: "one" })
      const tool = await BossCancelTool.init()
      const result = await tool.execute({ sessionID: worker.id, taskID: "t1" }, ctx(boss.id))
      expect(result.metadata).toMatchObject({ cancelled: true })
      expect(await SessionInbox.list(worker.id)).toHaveLength(0)
    })
  })
})
