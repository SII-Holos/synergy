import { expect, spyOn, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Question } from "../../src/question"
import { testRuntime } from "../support/runtime"

const actor = (subjectID: string) => ({
  kind: "account" as const,
  orgID: "fixture-org",
  subjectID,
  displayName: subjectID,
  clientKind: "web" as const,
  requestID: `command-${subjectID}`,
})

test("a native question has one durable attributed winner while its private input stays out of receipts", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => asked.resolve(properties.id))
        try {
          const pending = Question.ask({
            sessionID: session.id,
            questions: [{ question: "Fixture private input", header: "Private", options: [], input_type: "password" }],
          })
          const requestID = await asked.promise
          const results = await Promise.all([
            Question.decide({
              sessionID: session.id,
              requestID,
              reply: "answer",
              answers: [["fixture-private-answer"]],
              actor: actor("B"),
            }),
            Question.decide({
              sessionID: session.id,
              requestID,
              reply: "answer",
              answers: [["late-answer"]],
              actor: actor("C"),
            }),
          ])
          expect(await pending).toEqual([["fixture-private-answer"]])
          expect(results.map((result) => result.status)).toEqual(["resolved", "already_resolved"])
          expect(results[0].receipt).toMatchObject({
            actor: actor("B"),
            outcome: { kind: "question", reply: "answer", answers: [["[redacted]"]] },
          })
          expect(results[1].receipt).toEqual(results[0].receipt)
          expect(JSON.stringify(results)).not.toContain("fixture-private-answer")
          expect(
            await Question.decide({ sessionID: session.id, requestID, reply: "reject", actor: actor("C") }),
          ).toMatchObject({ status: "already_resolved", receipt: { actor: actor("B") } })
        } finally {
          unsubscribe()
        }
      },
    }),
  )
})

test("a failed question receipt or outer admission commit retains the original pending question", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => asked.resolve(properties.id))
        try {
          const pending = Question.ask({
            sessionID: session.id,
            questions: [{ question: "Continue?", header: "Continue", options: [] }],
          })
          const requestID = await asked.promise
          const failing = spyOn(Storage, "write").mockRejectedValueOnce(new Error("fixture receipt failure"))
          try {
            await expect(
              Question.decide({
                sessionID: session.id,
                requestID,
                reply: "answer",
                answers: [["lost"]],
                actor: actor("B"),
              }),
            ).rejects.toThrow("fixture receipt failure")
            expect((await Question.list()).map((item) => item.id)).toEqual([requestID])
          } finally {
            failing.mockRestore()
          }
          await expect(
            Storage.transaction(async () => {
              await Question.decide({
                sessionID: session.id,
                requestID,
                reply: "answer",
                answers: [["rolled-back"]],
                actor: actor("B"),
              })
              throw new Error("fixture admission rollback")
            }),
          ).rejects.toThrow("fixture admission rollback")
          expect((await Question.list()).map((item) => item.id)).toEqual([requestID])
          expect(
            await Question.decide({
              sessionID: session.id,
              requestID,
              reply: "answer",
              answers: [["winner"]],
              actor: actor("C"),
            }),
          ).toMatchObject({ status: "resolved", receipt: { actor: actor("C") } })
          expect(await pending).toEqual([["winner"]])
        } finally {
          unsubscribe()
        }
      },
    }),
  )
})
