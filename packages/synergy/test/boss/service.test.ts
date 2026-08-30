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

async function bossAndWorker(): Promise<{ boss: Session.Info; worker: Session.Info }> {
  const boss = await Session.create({})
  await SessionWorkflowService.enableBoss(boss.id)
  const worker = await BossService.spawn(boss.id, { role: "code" })
  return { boss, worker }
}

describe("BossService", () => {
  test("spawn creates a persistent specialist worker as a direct child", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      expect(worker.parentID).toBe(boss.id)
      expect(worker.agentOverride).toBe("synergy")
      expect(worker.interaction?.mode).toBe("unattended")
      expect(worker.workflow).toEqual({
        kind: "boss",
        role: "worker",
        workerRole: "code",
        rootID: boss.id,
      })
      expect(worker.title).toContain("code")
    })
  })

  test("spawn rejects non-boss callers and unknown agents", async () => {
    await withScope(async () => {
      const plain = await Session.create({})
      await expect(BossService.spawn(plain.id, { role: "code" })).rejects.toThrow("not part of a Boss Mode tree")

      const { boss } = await bossAndWorker()
      await expect(BossService.spawn(boss.id, { role: "code", agent: "definitely-not-an-agent" })).rejects.toThrow(
        "Unknown agent",
      )
    })
  })

  test("assign delivers a task inbox item and is idempotent per taskID", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const first = await BossService.assign(boss.id, {
        sessionID: worker.id,
        taskID: "task-1",
        task: "Implement the widget",
        acceptance: ["tests pass"],
      })
      expect(first.created).toBe(true)

      const items = await SessionInbox.list(worker.id)
      expect(items).toHaveLength(1)
      expect(items[0].mode).toBe("task")
      expect(items[0].deliveryKey).toBe(`boss:${boss.id}:task-1`)

      const second = await BossService.assign(boss.id, {
        sessionID: worker.id,
        taskID: "task-1",
        task: "Implement the widget",
      })
      expect(second.created).toBe(false)
      expect(second.itemID).toBe(first.itemID)
      expect(await SessionInbox.list(worker.id)).toHaveLength(1)
    })
  })

  test("assign rejects targets outside the caller's direct children", async () => {
    await withScope(async () => {
      const bossA = await Session.create({})
      await SessionWorkflowService.enableBoss(bossA.id)
      const bossB = await Session.create({})
      await SessionWorkflowService.enableBoss(bossB.id)
      const worker = await BossService.spawn(bossB.id, { role: "code" })

      // bossA cannot assign to bossB's worker.
      await expect(BossService.assign(bossA.id, { sessionID: worker.id, taskID: "t", task: "x" })).rejects.toThrow(
        "not a direct child",
      )
      // boss cannot assign to a plain child session.
      const plainChild = await Session.create({ parentID: bossA.id })
      await expect(BossService.assign(bossA.id, { sessionID: plainChild.id, taskID: "t", task: "x" })).rejects.toThrow(
        "not a boss worker",
      )
      // non-boss caller cannot assign.
      const plain = await Session.create({})
      await expect(BossService.assign(plain.id, { sessionID: worker.id, taskID: "t", task: "x" })).rejects.toThrow(
        "not part of a Boss Mode tree",
      )
    })
  })

  test("report delivers a steer message to the parent and wakes it", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const result = await BossService.report(worker.id, {
        summary: "Done with the widget",
        status: "completed",
        refs: ["file.ts"],
      })
      const items = await SessionInbox.list(boss.id)
      expect(items).toHaveLength(1)
      expect(items[0].mode).toBe("steer")
      const part = items[0].message?.parts?.find((candidate) => candidate.type === "text")
      expect(part?.type).toBe("text")
      const text = part?.type === "text" ? part.text : ""
      expect(text).toContain("Status: completed")
      expect(text).toContain("Done with the widget")
      expect(text).toContain("file.ts")
    })
  })

  test("report rejects non-worker callers", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await expect(BossService.report(boss.id, { summary: "nope" })).rejects.toThrow("not a boss worker")
      const plain = await Session.create({})
      await expect(BossService.report(plain.id, { summary: "nope" })).rejects.toThrow("not part of a Boss Mode tree")
    })
  })

  test("cancel removes matching pending inbox items", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-1", task: "one" })
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-2", task: "two" })

      const result = await BossService.cancel(boss.id, { sessionID: worker.id, taskID: "task-1" })
      expect(result.cancelled).toBe(true)

      const remaining = await SessionInbox.list(worker.id)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].deliveryKey).toBe(`boss:${boss.id}:task-2`)
    })
  })

  test("status derives the full subtree with roles and current tasks", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const grandchild = await BossService.spawn(worker.id, { role: "research" })
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-1", task: "build feature" })

      const tree = await BossService.status(boss.id)
      expect(tree.role).toBe("boss")
      expect(tree.sessionID).toBe(boss.id)
      expect(tree.currentTask).toBeUndefined()
      expect(tree.children).toHaveLength(1)

      const workerNode = tree.children[0]
      expect(workerNode.role).toBe("worker")
      expect(workerNode.workerRole).toBe("code")
      expect(workerNode.currentTask).toMatchObject({ taskID: "task-1", taskTitle: "build feature" })
      expect(workerNode.children).toHaveLength(1)
      expect(workerNode.children[0].workerRole).toBe("research")
    })
  })

  test("status skips archived children and enforces depth", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const archivedChild = await BossService.spawn(boss.id, { role: "stale" })
      await Session.update(archivedChild.id, (draft) => {
        draft.time.archived = Date.now()
      })

      const tree = await BossService.status(boss.id)
      expect(tree.children.map((child) => child.sessionID)).toEqual([worker.id])

      const shallow = await BossService.status(boss.id, { depth: 0 })
      expect(shallow.children).toHaveLength(0)
    })
  })

  test("status rejects non-boss callers", async () => {
    await withScope(async () => {
      const plain = await Session.create({})
      await expect(BossService.status(plain.id)).rejects.toThrow("not part of a Boss Mode tree")
    })
  })

  test("spawn persists standing instructions in the worker workflow", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, {
        role: "code",
        instructions: "Always use the project formatter before finishing.",
      })
      const stored = await Session.get(worker.id)
      expect(stored.workflow?.kind).toBe("boss")
      if (stored.workflow?.kind !== "boss") return
      expect(stored.workflow.instructions).toBe("Always use the project formatter before finishing.")
    })
  })

  test("spawn rejects agents that are hidden or not visible to the caller", async () => {
    await withScope(async () => {
      const { boss } = await bossAndWorker()
      // Hidden internal subagents must not be spawnable as workers.
      await expect(BossService.spawn(boss.id, { role: "code", agent: "requirements-engineer" })).rejects.toThrow(
        "not delegatable",
      )
    })
  })

  test("status reports queued for workers with pending inbox tasks", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      // Enqueue a task without waking the worker. BossService.assign wakes the
      // worker (which makes it busy); queued is the state where runnable work
      // exists but the runtime has not picked it up yet (e.g. after recovery).
      await SessionInbox.deliver({
        sessionID: worker.id,
        mode: "task",
        message: {
          role: "user",
          agent: worker.agentOverride,
          origin: { type: "system", detail: "boss_assign" },
          visible: true,
          parts: [{ type: "text", text: "do it" }],
          metadata: { boss: { from: boss.id, to: worker.id, taskID: "t-1", taskTitle: "do it" } },
        },
      })
      const tree = await BossService.status(boss.id)
      expect(tree.children[0].status).toBe("queued")
    })
  })

  test("cancel with a non-running taskID leaves the running turn alone", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      // Materialize task A as the running assignment and queue task B.
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-a", task: "A" })
      const items = await SessionInbox.list(worker.id)
      const stored = await SessionInbox.getStored(worker.id, items[0].id)
      await SessionInbox.materializeItem(stored)
      await SessionInbox.commitReady(
        worker.id,
        items.map((item) => item.id),
      )
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-b", task: "B" })

      // Cancelling task-b removes the queued item without touching task-a.
      const result = await BossService.cancel(boss.id, { sessionID: worker.id, taskID: "task-b" })
      expect(result.cancelled).toBe(true)
      expect(await SessionInbox.list(worker.id)).toHaveLength(0)
    })
  })

  test("report rejects when the parent left the boss tree", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await SessionWorkflowService.setNone(boss.id)
      await expect(BossService.report(worker.id, { summary: "late report" })).rejects.toThrow(
        "not part of a Boss Mode tree",
      )
    })
  })

  test("report carries the originating taskID in metadata", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-1", task: "Do it" })
      const items = await SessionInbox.list(worker.id)
      const stored = await SessionInbox.getStored(worker.id, items[0].id)
      await SessionInbox.materializeItem(stored)
      await SessionInbox.commitReady(
        worker.id,
        items.map((item) => item.id),
      )

      await BossService.report(worker.id, { summary: "Done" })
      const bossItems = await SessionInbox.list(boss.id)
      const report = bossItems[0].message?.metadata?.boss as Record<string, unknown> | undefined
      expect(report?.taskID).toBe("task-1")
    })
  })

  test("status keeps a worker assignment after a child report is materialized", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await BossService.assign(boss.id, { sessionID: worker.id, taskID: "task-1", task: "Do it" })
      const workerItems = await SessionInbox.list(worker.id)
      const workerTask = await SessionInbox.getStored(worker.id, workerItems[0].id)
      const taskMessage = await SessionInbox.materializeItem(workerTask)
      await SessionInbox.commitReady(
        worker.id,
        workerItems.map((item) => item.id),
      )

      const child = await BossService.spawn(worker.id, { role: "test" })
      await BossService.assign(worker.id, { sessionID: child.id, taskID: "child-task", task: "Check it" })
      const childItems = await SessionInbox.list(child.id)
      const childTask = await SessionInbox.getStored(child.id, childItems[0].id)
      await SessionInbox.materializeItem(childTask)
      await SessionInbox.commitReady(
        child.id,
        childItems.map((item) => item.id),
      )
      await BossService.report(child.id, { summary: "Checked", status: "completed" })
      const reportItems = await SessionInbox.list(worker.id)
      const report = await SessionInbox.getStored(worker.id, reportItems[0].id)
      await SessionInbox.materializeItem(report, taskMessage!.info.id, { guiding: true })
      await SessionInbox.commitReady(
        worker.id,
        reportItems.map((item) => item.id),
      )

      const tree = await BossService.status(boss.id)
      expect(tree.children[0].currentTask).toEqual({ taskID: "task-1", taskTitle: "Do it" })
    })
  })
})
