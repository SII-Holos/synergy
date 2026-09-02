import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
import {
  BOSS_DISCIPLINE_BLOCK,
  DEFAULT_IDENTITY_TEXT,
  buildBossContext,
  buildBossDeliveryHint,
  buildRuntimeBossContext,
} from "../../src/boss/boss-prompt"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("boss identity prompt", () => {
  test("BOSS_DISCIPLINE_BLOCK contains the collaboration discipline sections", () => {
    expect(BOSS_DISCIPLINE_BLOCK).toContain("<boss-identity>")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("Dispatch discipline")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("Layered reporting discipline")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("Memory discipline")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("Feishu source headers")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("lark-cli history reading")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("boss_project")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("session_send")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("session_read")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("memory_write")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("chat-messages-list")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("messages-search")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("chat-search")
    expect(BOSS_DISCIPLINE_BLOCK).toContain("im:message:readonly")
  })

  test("buildRuntimeBossContext injects persona + discipline + instructions", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableBoss(session.id)
      const context = buildRuntimeBossContext(session, {
        identityText: "我是同事小飞",
        instructions: "只汇报摘要",
      })
      expect(context).toContain("<boss-context>")
      expect(context).toContain(BOSS_DISCIPLINE_BLOCK)
      expect(context).toContain("<boss-persona>")
      expect(context).toContain("我是同事小飞")
      expect(context).toContain("只汇报摘要")
    })
  })

  test("buildRuntimeBossContext without identity still injects discipline and the default persona", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableBoss(session.id)
      const context = buildRuntimeBossContext(session, {})
      expect(context).toContain("<boss-context>")
      expect(context).toContain(BOSS_DISCIPLINE_BLOCK)
      expect(context).toContain("<boss-persona>")
      expect(context).toContain(DEFAULT_IDENTITY_TEXT)
    })
  })

  test("buildRuntimeBossContext with a custom identity overrides the default persona", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableBoss(session.id)
      const context = buildRuntimeBossContext(session, { identityText: "我是同事小飞" })
      expect(context).toContain("<boss-persona>")
      expect(context).toContain("我是同事小飞")
      expect(context).not.toContain(DEFAULT_IDENTITY_TEXT)
    })
  })

  test("buildBossContext keeps the legacy base text (worker-tree semantics preserved)", () => {
    const text = buildBossContext({ id: "ses_x", title: "t", version: "1" } as Session.Info)
    expect(text).toContain("<boss-context>")
    expect(text).toContain("boss_spawn")
    expect(text).toContain("boss_assign")
    expect(text).toContain("boss_report")
  })
})

describe("boss delivery hint", () => {
  test("auto delivery hint warns against duplicate channel_push", () => {
    const hint = buildBossDeliveryHint({ auto: true, replyToMessageId: "om_123" })
    expect(hint).toContain("<boss-delivery>")
    expect(hint).toContain("自动投递回飞书")
    expect(hint).toContain("不要调用 channel_push")
    expect(hint).toContain("om_123")
  })

  test("manual delivery hint instructs channel_push when not auto-bound", () => {
    const hint = buildBossDeliveryHint({ auto: false })
    expect(hint).toContain("<boss-delivery>")
    expect(hint).toContain("不会自动投递回飞书")
    expect(hint).toContain("channel_push")
  })

  test("undefined delivery falls back to manual hint", () => {
    const hint = buildBossDeliveryHint(undefined)
    expect(hint).toContain("不会自动投递回飞书")
  })
})
