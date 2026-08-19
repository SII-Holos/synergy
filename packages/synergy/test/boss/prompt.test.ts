import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { BossService } from "../../src/session/boss"
import { buildBossContext, buildWorkerContext, renderBossTree } from "../../src/session/boss-prompt"
import { SessionWorkflowService } from "../../src/session/workflow"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("Boss Mode prompt builders", () => {
  test("boss context instructs delegation, monitoring, and human decisions", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const text = buildBossContext(await Session.get(boss.id))
      expect(text).toContain("<boss-context>")
      expect(text).toContain("boss_spawn")
      expect(text).toContain("boss_assign")
      expect(text).toContain("boss_status")
      expect(text).toContain("boss_cancel")
      expect(text).toContain("boss_report")
      expect(text).toContain("Answer simple requests directly when they do not need a worker")
      expect(text).toContain("ask the human")
    })
  })

  test("worker context names the role, the root, and boss_report", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })
      const text = buildWorkerContext(await Session.get(worker.id))
      expect(text).toContain("<boss-worker-context>")
      expect(text).toContain("code specialist worker")
      expect(text).toContain(`rooted at session ${boss.id}`)
      expect(text).toContain("boss_report")
      expect(text).toContain('"blocked"')
      expect(text).toContain("You do not contact the human directly")
    })
  })

  test("renderBossTree renders status, role, sessionID, and task", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })
      await BossService.assign(boss.id, {
        sessionID: worker.id,
        taskID: "task-1",
        task: "Implement the widget",
      })
      const tree = await BossService.status(boss.id)
      const text = renderBossTree(tree)
      expect(text).toContain(`- [idle] ${boss.title} (boss, ${boss.id})`)
      expect(text).toMatch(
        new RegExp(`- \\[(running|idle|queued)\\] ${escapeRegExp(worker.title)} \\(worker\\(code\\), ${worker.id}\\)`),
      )
      expect(text).toContain("task: task-1 — Implement the widget")
    })
  })
})
