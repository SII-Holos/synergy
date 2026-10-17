import { describe, expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BossService } from "../../src/boss/boss"
import { buildBossContext, buildWorkerContext, renderBossTree } from "../../src/boss/boss-prompt"
import { WorkflowSessionService } from "@ericsanchezok/synergy-boss/session/workflow"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("Boss Mode prompt builders", () => {
  test("boss context instructs delegation, monitoring, and human decisions", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const boss = await Session.create({})
        await WorkflowSessionService.enableBoss(boss.id)
        const text = buildBossContext()
        expect(text).toContain("<boss-context>")
        expect(text).toContain("decide, delegate, monitor, and summarize")
        expect(text).toContain("specialist workers")
        expect(text).toContain("verified reports")
        expect(text).not.toMatch(/boss_spawn|boss_assign|boss_status|boss_cancel|boss_report/)
        expect(text).toContain("Answer simple requests directly when they do not need a worker")
        expect(text).toContain("ask the human")
      })
    }))

  test("worker context names the role, the root, and boss_report", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const boss = await Session.create({})
        await WorkflowSessionService.enableBoss(boss.id)
        const worker = await BossService.spawn(boss.id, { role: "code" })
        const text = buildWorkerContext(await Session.get(worker.id))
        expect(text).toContain("<boss-worker-context>")
        expect(text).toContain("code specialist worker")
        expect(text).toContain(`rooted at session ${boss.id}`)
        expect(text).toContain("boss_report")
        expect(text).toContain("completion, blockers, and decisions needing input")
        expect(text).toContain("You do not contact the human directly")
      })
    }))

  test("renderBossTree renders status, role, sessionID, and task", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const boss = await Session.create({})
        await WorkflowSessionService.enableBoss(boss.id)
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
          new RegExp(
            `- \\[(running|idle|queued)\\] ${escapeRegExp(worker.title)} \\(worker\\(code\\), ${worker.id}\\)`,
          ),
        )
        expect(text).toContain("task: task-1 — Implement the widget")
      })
    }))
})

afterRuntimeTests(() => runtime.close())
