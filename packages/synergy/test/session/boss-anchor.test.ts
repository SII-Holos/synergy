import { afterEach, describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { BossService } from "../../src/boss/boss"
import { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"

const originalConfigCurrent = Config.current

afterEach(async () => {
  Config.current = originalConfigCurrent
})

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

/** Inject a Feishu-routed user message (with channel anchor) into the boss session history. */
async function injectChannelMessage(sessionID: string, anchor: { chatId: string; messageId: string }) {
  const { createUserMessage } = await import("../../src/session/input")
  await createUserMessage({
    sessionID,
    agent: "synergy",
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "帮我看看" }],
    metadata: {
      channelReply: true,
      channelReplyToMessageId: anchor.messageId,
      channelChatId: anchor.chatId,
      channelSenderId: "ou_user",
      channelSenderName: "用户",
    },
  })
}

async function bossAndWorker(): Promise<{ boss: Session.Info; worker: Session.Info }> {
  const boss = await Session.create({})
  await SessionWorkflowService.enableBoss(boss.id)
  const worker = await BossService.spawn(boss.id, { role: "code" })
  return { boss, worker }
}

/** Hold the worker lease so scheduleWake cannot drive (and consume) its task item. */
async function withWorkerLease(workerID: string, fn: () => Promise<void>): Promise<void> {
  const lease = SessionManager.acquire(workerID)
  expect(lease).toBeDefined()
  if (!lease) return
  try {
    await fn()
  } finally {
    await SessionManager.release(lease, { requestNextWork: false })
  }
}

describe("boss channel anchor propagation", () => {
  test("boss_assign carries the originating Feishu anchor into the task metadata", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await injectChannelMessage(boss.id, { chatId: "oc_anchor", messageId: "om_anchor" })
      await withWorkerLease(worker.id, async () => {
        await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t1", task: "干个活" })
        const items = await SessionInbox.list(worker.id)
        expect(items).toHaveLength(1)
        const bossMeta = (items[0]!.message!.metadata as { boss?: Record<string, unknown> }).boss
        expect(bossMeta).toBeDefined()
        expect(bossMeta!.channel).toMatchObject({ chatId: "oc_anchor", replyToMessageId: "om_anchor" })
      })
    })
  })

  test("boss_assign prefers the explicit current-turn anchor over a newer history anchor", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      // Older anchor in the session history.
      await injectChannelMessage(boss.id, { chatId: "oc_old", messageId: "om_old" })
      // Current turn's user message with a different anchor.
      const { createUserMessage } = await import("../../src/session/input")
      const created = await createUserMessage({
        sessionID: boss.id,
        agent: "synergy",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "帮我看看这个" }],
        metadata: {
          channelReply: true,
          channelReplyToMessageId: "om_current",
          channelChatId: "oc_current",
        },
      })
      await withWorkerLease(worker.id, async () => {
        await BossService.assign(
          boss.id,
          { sessionID: worker.id, taskID: "t2", task: "干个活" },
          { anchorMessageID: created.info.id },
        )
        const items = await SessionInbox.list(worker.id)
        const bossMeta = (items[0]!.message!.metadata as { boss?: Record<string, unknown> }).boss
        expect(bossMeta!.channel).toMatchObject({ chatId: "oc_current", replyToMessageId: "om_current" })
      })
    })
  })

  test("boss_report carries the task's Feishu anchor back so the boss replies to the source chat", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await injectChannelMessage(boss.id, { chatId: "oc_anchor", messageId: "om_anchor" })
      await withWorkerLease(worker.id, async () => {
        await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t1", task: "干个活" })
        await BossService.report(worker.id, { summary: "干完了", status: "completed" })
      })
      const items = await SessionInbox.list(boss.id)
      const report = items.find((item) => item.message?.origin?.detail === "boss_report")
      expect(report).toBeDefined()
      const metadata = report!.message!.metadata as Record<string, unknown>
      expect(metadata.channelReply).toBe(true)
      expect(metadata.channelReplyToMessageId).toBe("om_anchor")
      expect(metadata.channelChatId).toBe("oc_anchor")
      expect((metadata.boss as Record<string, unknown>).taskID).toBe("t1")
    })
  })

  test("boss_report without a channel anchor stays channel-free", async () => {
    await withScope(async () => {
      const { boss, worker } = await bossAndWorker()
      await withWorkerLease(worker.id, async () => {
        await BossService.assign(boss.id, { sessionID: worker.id, taskID: "t1", task: "干个活" })
        await BossService.report(worker.id, { summary: "干完了" })
      })
      const items = await SessionInbox.list(boss.id)
      const report = items.find((item) => item.message?.origin?.detail === "boss_report")
      expect(report).toBeDefined()
      const metadata = report!.message!.metadata as Record<string, unknown>
      expect(metadata.channelReply).toBeUndefined()
      expect(metadata.channelReplyToMessageId).toBeUndefined()
    })
  })
})

describe("boss_spawn workspace selection", () => {
  test("default (main) worker inherits the caller's workspace", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code" })
      expect(worker.workspace?.type).toBe("main")
      expect(worker.workspace?.scopeID).toBe((boss.scope as Scope).id)
    })
  })

  test("workspace=worktree creates and binds a fresh git worktree for the worker", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await BossService.spawn(boss.id, { role: "code", workspace: "worktree" })
      expect(worker.workspace?.type).toBe("git_worktree")
      expect(typeof worker.workspace?.worktreeID).toBe("string")
      expect(worker.workspace?.scopeID).toBe((boss.scope as Scope).id)
    })
  })

  test("workspace=worktree fails cleanly when the caller scope is not a Git project", async () => {
    await using tmp = await tmpdir({ git: false })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const boss = await Session.create({})
        await SessionWorkflowService.enableBoss(boss.id)
        await expect(BossService.spawn(boss.id, { role: "code", workspace: "worktree" })).rejects.toMatchObject({
          code: "worktree_failed",
        })
        // The failed worker session was rolled back: boss has no children.
        expect(await Session.children(boss.id)).toHaveLength(0)
      },
    })
  })
})
