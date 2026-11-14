import { expect, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Question } from "../../src/question"
import { testRuntime } from "../support/runtime"

test("native Question and permission windows share a Scope view and continue after an answered question", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
        const controller = new AbortController()
        const pending: Promise<unknown>[] = []
        try {
          pending.push(
            PermissionNext.ask({
              id: "permission-shared-view",
              sessionID: session.id,
              permission: "bash",
              patterns: ["fixture *"],
              metadata: {},
              ruleset: [],
              signal: controller.signal,
            }).catch((error: unknown) => error),
          )
          for (let index = 0; index < 2; index++) {
            const asked = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(Question.Event.Asked, () => asked.resolve())
            pending.push(
              Question.ask({
                sessionID: session.id,
                questions: [{ question: `Fixture ${index}`, header: "Fixture", options: [] }],
                signal: controller.signal,
              }).catch((error: unknown) => error),
            )
            try {
              await asked.promise
            } finally {
              unsubscribe()
            }
          }
          const permission = await PermissionNext.pendingPage({ sessionID: session.id, limit: 1 })
          const first = await Question.pendingPage({ sessionID: session.id, limit: 1 })
          expect(first.viewID).toBe(permission.viewID)
          expect(first.hasMore).toBeTrue()
          expect(first.items[0]!.ordinal).toBeGreaterThan(permission.items[0]!.ordinal)
          const cursor = first.items[0]!
          await Question.reply({ requestID: cursor.info.id, answers: [["fixture answer"]] })
          const second = await Question.pendingPage({
            sessionID: session.id,
            limit: 1,
            after: cursor.ordinal,
            viewID: first.viewID,
          })
          expect(second.items[0]?.info.questions[0]?.question).toBe("Fixture 1")
          expect(second.hasMore).toBeFalse()
          expect((await Question.pendingPage({ sessionID: "session-unrelated", limit: 1 })).items).toEqual([])
        } finally {
          controller.abort()
          await Promise.allSettled(pending)
        }
      },
    }),
  )
})
