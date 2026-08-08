import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService } from "../../src/session/workflow"
import { BossService } from "../../src/session/boss"
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
})
