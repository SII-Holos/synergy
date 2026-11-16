import { expect, spyOn, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Question } from "../../src/question"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const actor = (subjectID: string) => ({
  kind: "account" as const,
  orgID: "fixture-org",
  subjectID,
  displayName: subjectID,
  clientKind: "web" as const,
  requestID: `command-${subjectID}`,
})
async function pendingQuestion(signal?: AbortSignal) {
  const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
  const asked = Promise.withResolvers<string>()
  const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => {
    if (properties.sessionID === session.id) asked.resolve(properties.id)
  })
  const result = Question.ask({
    sessionID: session.id,
    questions: [{ question: "Private fixture", header: "Private", options: [], input_type: "password" }],
    signal,
  })
  try {
    return { sessionID: session.id, requestID: await asked.promise, result }
  } finally {
    unsubscribe()
  }
}

test("an uncertain native question commit reconciles the original private answer without accepting the retry's values", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const pending = await pendingQuestion()
        const store = Storage.current().store
        const transaction = store.transaction.bind(store)
        const lost = spyOn(store, "transaction").mockImplementationOnce(async (body, options) => {
          await transaction(body, options)
          throw new Storage.CommitUnknownError(undefined, new Error("fixture lost SQL acknowledgement"))
        })
        try {
          await expect(
            Question.decide({ ...pending, reply: "answer", answers: [["original-private-value"]], actor: actor("B") }),
          ).rejects.toBeInstanceOf(Storage.CommitUnknownError)
          expect((await Question.list()).map((item) => item.id)).toEqual([pending.requestID])
        } finally {
          lost.mockRestore()
        }
        const retry = await Question.decide({
          ...pending,
          reply: "answer",
          answers: [["retry-private-value"]],
          actor: actor("C"),
        })
        expect(retry).toMatchObject({
          status: "already_resolved",
          receipt: { actor: actor("B"), outcome: { answers: [["[redacted]"]] } },
        })
        expect(JSON.stringify(retry)).not.toContain("original-private-value")
        expect(JSON.stringify(retry)).not.toContain("retry-private-value")
        expect(await pending.result).toEqual([["original-private-value"]])
        expect(await Question.list()).toEqual([])
      },
    }),
  )
})

test("restart retains a question winner but cannot approve an old unanswered identity", async () => {
  await using directory = await tmpdir()
  let runtime = await testRuntime({ home: directory.path })
  try {
    const identities = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const answered = await pendingQuestion()
          await Question.decide({
            ...answered,
            reply: "answer",
            answers: [["private-before-restart"]],
            actor: actor("B"),
          })
          await answered.result
          const controller = new AbortController()
          const unanswered = await pendingQuestion(controller.signal)
          const rejected = unanswered.result.catch((error: unknown) => error)
          controller.abort()
          expect(await rejected).toBeInstanceOf(DOMException)
          return {
            answered: { sessionID: answered.sessionID, requestID: answered.requestID },
            unanswered: { sessionID: unanswered.sessionID, requestID: unanswered.requestID },
          }
        },
      }),
    )
    await runtime.close()
    runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          expect(await Question.list()).toEqual([])
          expect(await Question.decide({ ...identities.answered, reply: "reject", actor: actor("C") })).toMatchObject({
            status: "already_resolved",
            receipt: { actor: actor("B"), outcome: { answers: [["[redacted]"]] } },
          })
          expect(
            await Question.decide({
              ...identities.unanswered,
              reply: "answer",
              answers: [["late"]],
              actor: actor("C"),
            }),
          ).toEqual({ status: "expired" })
        },
      }),
    )
  } finally {
    await runtime.close()
  }
})
