import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { BossContinuationPolicy } from "../../src/boss/boss-continuation"
import { BossService } from "../../src/boss/boss"
import { SessionInbox } from "../../src/session/inbox"
import { SessionWorkflowService } from "../../src/session/workflow"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test-provider", modelID: "test-model" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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

/** Assign a task, materialize it as a user message, and drain the inbox so the policy's runnable-item check passes. */
async function assignedTaskMaterialized(workerID: string, bossID: string): Promise<string> {
  await BossService.assign(bossID, {
    sessionID: workerID,
    taskID: "task-1",
    task: "Implement the widget",
    acceptance: ["tests pass"],
  })
  const items = await SessionInbox.list(workerID)
  const stored = await SessionInbox.getStored(workerID, items[0].id)
  const materialized = await SessionInbox.materializeItem(stored)
  await SessionInbox.commitReady(
    workerID,
    items.map((item) => item.id),
  )
  return materialized!.info.id
}

async function terminalAssistant(workerID: string, parentID: string): Promise<string> {
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: workerID,
    parentID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: workerID,
    messageID: assistant.id,
    type: "text",
    text: "working on it",
  })
  return assistant.id
}

async function completedBossReport(workerID: string, assistantID: string): Promise<void> {
  const now = Date.now()
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: workerID,
    messageID: assistantID,
    type: "tool",
    callID: Identifier.ascending("tool"),
    tool: "boss_report",
    state: {
      status: "completed",
      input: { summary: "Done", status: "completed" },
      output: "Report delivered",
      title: "Report to parent",
      metadata: {},
      time: { start: now, end: now },
    },
  })
}

async function materializeFirstInboxItem(sessionID: string, rootID?: string): Promise<void> {
  const items = await SessionInbox.list(sessionID)
  const stored = await SessionInbox.getStored(sessionID, items[0].id)
  await SessionInbox.materializeItem(stored, rootID, rootID ? { guiding: true } : undefined)
  await SessionInbox.commitReady(
    sessionID,
    items.map((item) => item.id),
  )
}

async function gateFor(sessionID: string, terminalMessageID: string) {
  const session = await Session.get(sessionID)
  return {
    session,
    scopeID: (session.scope as Scope).id,
    sessionID,
    terminalMessageID,
  }
}

describe("BossContinuationPolicy", () => {
  test("worker with an unreported assigned task gets an inbox proposal", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const taskUserID = await assignedTaskMaterialized(worker.id, boss.id)
      const assistantID = await terminalAssistant(worker.id, taskUserID)

      const proposal = await BossContinuationPolicy.handle(await gateFor(worker.id, assistantID))
      expect(proposal?.kind).toBe("inbox")
      if (proposal?.kind !== "inbox") return
      expect(proposal.mode).toBe("steer")
      expect(proposal.message.role).toBe("user")
      expect(proposal.message.metadata?.source).toBe("boss_continuation")
      const text = proposal.message.parts.find((part) => part.type === "text")
      expect(text?.type === "text" ? (text as { text: string }).text : "").toContain("boss_report")
    })
  })

  test("child reports do not restart a worker that already reported its own task", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const taskUserID = await assignedTaskMaterialized(worker.id, boss.id)
      const reportedAssistantID = await terminalAssistant(worker.id, taskUserID)
      await completedBossReport(worker.id, reportedAssistantID)

      const child = await BossService.spawn(worker.id, { role: "test" })
      await BossService.assign(worker.id, {
        sessionID: child.id,
        taskID: "child-task",
        task: "Check the widget",
      })
      await materializeFirstInboxItem(child.id)
      await BossService.report(child.id, { summary: "Widget checked", status: "completed" })
      await materializeFirstInboxItem(worker.id, taskUserID)
      const terminalMessageID = await terminalAssistant(worker.id, taskUserID)

      const proposal = await BossContinuationPolicy.handle(await gateFor(worker.id, terminalMessageID))
      expect(proposal).toBeUndefined()
    })
  })

  test("worker without any task yields no proposal", async () => {
    await withScope(async () => {
      const { worker } = await bossAndWorker()
      const proposal = await BossContinuationPolicy.handle(await gateFor(worker.id, "msg_unused"))
      expect(proposal).toBeUndefined()
    })
  })

  test("boss session never gets a continuation proposal", async () => {
    await withScope(async () => {
      const { boss } = await bossAndWorker()
      const proposal = await BossContinuationPolicy.handle(await gateFor(boss.id, "msg_unused"))
      expect(proposal).toBeUndefined()
    })
  })

  test("worker falls dormant when the root is no longer boss", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      const taskUserID = await assignedTaskMaterialized(worker.id, boss.id)
      const assistantID = await terminalAssistant(worker.id, taskUserID)
      await SessionWorkflowService.setNone(boss.id)

      const proposal = await BossContinuationPolicy.handle(await gateFor(worker.id, assistantID))
      expect(proposal).toBeUndefined()
    })
  })
})
