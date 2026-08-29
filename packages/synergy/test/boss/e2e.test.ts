import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService } from "../../src/session/workflow"
import { BossService } from "../../src/boss/boss"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("Boss Mode end-to-end", () => {
  test("human speaks to the boss; boss spawns three workers, assigns tasks, workers report, tree reflects everything", async () => {
    await withScope(async () => {
      // Human creates a session and enables Boss Mode — the root boss.
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      expect(boss.workflow).toBeUndefined() // before enable

      // Boss spawns three specialist workers.
      const code = await BossService.spawn(boss.id, { role: "code" })
      const review = await BossService.spawn(boss.id, { role: "review", agent: "synergy-max" })
      const research = await BossService.spawn(boss.id, { role: "research" })

      // Boss assigns one task per worker.
      await BossService.assign(boss.id, { sessionID: code.id, taskID: "t-1", task: "Implement the widget" })
      await BossService.assign(boss.id, { sessionID: review.id, taskID: "t-2", task: "Review the widget" })
      await BossService.assign(boss.id, { sessionID: research.id, taskID: "t-3", task: "Research the widget" })

      // Each worker has exactly one runnable task inbox item.
      expect(await SessionInbox.list(code.id)).toHaveLength(1)
      expect(await SessionInbox.list(review.id)).toHaveLength(1)
      expect(await SessionInbox.list(research.id)).toHaveLength(1)

      // A worker reports back to the boss after finishing.
      await BossService.report(code.id, { summary: "Widget implemented", status: "completed", refs: ["src/widget.ts"] })
      await BossService.report(review.id, { summary: "Review done", status: "completed" })

      // The boss received both reports as steer messages.
      const bossInbox = await SessionInbox.list(boss.id)
      expect(bossInbox).toHaveLength(2)
      expect(bossInbox.every((item) => item.mode === "steer")).toBe(true)

      // The tree reflects three workers, roles, agent, and current tasks.
      const tree = await BossService.status(boss.id)
      expect(tree.role).toBe("boss")
      expect(tree.children).toHaveLength(3)
      const roles = tree.children.map((child) => child.workerRole).sort()
      expect(roles).toEqual(["code", "research", "review"])
      const reviewNode = tree.children.find((child) => child.sessionID === review.id)
      expect(reviewNode?.agent).toBe("synergy-max")
      expect(reviewNode?.currentTask).toMatchObject({ taskID: "t-2" })
    })
  })

  test("any-depth: a worker spawns a sub-worker and the root sees the full subtree", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const code = await BossService.spawn(boss.id, { role: "code" })
      const sub = await BossService.spawn(code.id, { role: "lint" })
      await BossService.assign(code.id, { sessionID: sub.id, taskID: "s-1", task: "Lint the widget" })

      // The intermediate worker reports its sub-worker's outcome upward.
      await BossService.report(sub.id, { summary: "Lint clean", status: "completed" })
      const codeInbox = await SessionInbox.list(code.id)
      expect(codeInbox).toHaveLength(1)
      expect(codeInbox[0].mode).toBe("steer")

      // Root boss sees the full two-level subtree.
      const tree = await BossService.status(boss.id)
      expect(tree.children).toHaveLength(1)
      expect(tree.children[0].children).toHaveLength(1)
      expect(tree.children[0].children[0].workerRole).toBe("lint")
      expect(tree.children[0].children[0].currentTask).toMatchObject({ taskID: "s-1" })
    })
  })

  test("idempotency: re-assigning the same taskID delivers only once", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })

      const first = await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t-1", task: "Do it" })
      const second = await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t-1", task: "Do it again" })
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.itemID).toBe(first.itemID)
      expect(await SessionInbox.list(worker.id)).toHaveLength(1)
    })
  })

  test("restart simulation: pending tasks and tree survive a runtime reset", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t-1", task: "Persist me" })

      // Simulate a process restart: drop the in-memory runtime so the next
      // access re-reads from storage.
      for (const sessionID of [boss.id, worker.id]) {
        SessionManager.unregisterRuntime(sessionID)
      }

      // The worker's pending task is still runnable from storage.
      const runnable = await SessionInbox.list(worker.id)
      expect(runnable).toHaveLength(1)
      expect(runnable[0].mode).toBe("task")

      // The tree still derives correctly after the reset.
      const tree = await BossService.status(boss.id)
      expect(tree.sessionID).toBe(boss.id)
      expect(tree.children).toHaveLength(1)
      expect(tree.children[0].currentTask).toMatchObject({ taskID: "t-1", taskTitle: "Persist me" })
    })
  })

  test("disabling the root makes the tree unavailable but workers keep their tasks", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t-1", task: "Do it" })

      await SessionWorkflowService.setNone(boss.id)
      await expect(BossService.status(boss.id)).rejects.toThrow("not part of a Boss Mode tree")

      // Worker keeps its task and remains addressable for cleanup/archive.
      expect(await SessionInbox.list(worker.id)).toHaveLength(1)
      expect(worker.workflow?.kind).toBe("boss")
    })
  })
})
