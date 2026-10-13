import { describe, expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkflowSessionService } from "../../src/session/workflow"
import {
  BOSS_DISCIPLINE_BLOCK,
  DEFAULT_IDENTITY_TEXT,
  buildBossContext,
  buildRuntimeBossContext,
} from "@ericsanchezok/synergy-boss/boss/boss-prompt"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("boss identity prompt", () => {
  test("BOSS_DISCIPLINE_BLOCK contains the collaboration discipline sections", () =>
    runtime.run(() => {
      expect(BOSS_DISCIPLINE_BLOCK).toContain("<boss-identity>")
      expect(BOSS_DISCIPLINE_BLOCK).toContain("Dispatch discipline")
      expect(BOSS_DISCIPLINE_BLOCK).toContain("Layered reporting discipline")
      expect(BOSS_DISCIPLINE_BLOCK).not.toMatch(/memory_|agenda_|note_|Feishu|lark-cli|morning/)
    }))

  test("buildRuntimeBossContext injects persona + discipline + instructions", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const session = await Session.create({})
        await WorkflowSessionService.enableBoss(session.id)
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
    }))

  test("buildRuntimeBossContext without identity still injects discipline and the default persona", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const session = await Session.create({})
        await WorkflowSessionService.enableBoss(session.id)
        const context = buildRuntimeBossContext(session, {})
        expect(context).toContain("<boss-context>")
        expect(context).toContain(BOSS_DISCIPLINE_BLOCK)
        expect(context).toContain("<boss-persona>")
        expect(context).toContain(DEFAULT_IDENTITY_TEXT)
      })
    }))

  test("buildRuntimeBossContext with a custom identity overrides the default persona", () =>
    runtime.run(async () => {
      await withScope(async () => {
        const session = await Session.create({})
        await WorkflowSessionService.enableBoss(session.id)
        const context = buildRuntimeBossContext(session, { identityText: "我是同事小飞" })
        expect(context).toContain("<boss-persona>")
        expect(context).toContain("我是同事小飞")
        expect(context).not.toContain(DEFAULT_IDENTITY_TEXT)
      })
    }))

  test("buildBossContext keeps the legacy base text (worker-tree semantics preserved)", () =>
    runtime.run(() => {
      const text = buildBossContext({ id: "ses_x", title: "t", version: "1" } as Session.Info)
      expect(text).toContain("<boss-context>")
      expect(text).toContain("boss_spawn")
      expect(text).toContain("boss_assign")
      expect(text).toContain("boss_report")
    }))
})

afterRuntimeTests(() => runtime.close())
