import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { Question } from "../../src/question"
import { questionTools } from "../../src/question/tools"

test("private Question input reaches its caller but is redacted from events and generic tool output", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
        const questions: Question.Info[] = [
          {
            question: "Private fixture value",
            header: "Private",
            options: [],
            input_type: "password",
            allow_custom: true,
          },
        ]
        const replies: Question.Answer[][] = []
        const unsubscribe = Bus.subscribe(Question.Event.Replied, (event) => {
          replies.push(event.properties.answers)
        })
        const unask = Bus.subscribe(Question.Event.Asked, async (event) => {
          expect(event.properties.questions).toEqual(questions)
          await Question.reply({ requestID: event.properties.id, answers: [["fixture-private-value"]] })
        })
        try {
          expect(await Question.ask({ sessionID: session.id, questions })).toEqual([["fixture-private-value"]])
          const [tool] = questionTools()
          const definition = await tool.init()
          const result = await definition.execute(
            { questions },
            {
              sessionID: session.id,
              messageID: "fixture-message",
              callID: "fixture-call",
              agent: "fixture",
              abort: new AbortController().signal,
              metadata() {},
              ask: async () => {},
            },
          )
          expect(JSON.stringify(result)).not.toContain("fixture-private-value")
          expect(result.metadata.answers).toEqual([["[redacted]"]])
          expect(replies).toEqual([[["[redacted]"]], [["[redacted]"]]])
        } finally {
          unsubscribe()
          unask()
        }
      },
    }),
  )
})

test("Question cancellation rejects the pending request and prevents a late reply", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ interaction: SessionInteraction.interactive("fixture") })
        const controller = new AbortController()
        let requestID = ""
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          requestID = event.properties.id
          controller.abort(new Error("fixture cancellation"))
        })
        try {
          await expect(
            Question.ask({
              sessionID: session.id,
              questions: [{ question: "Continue?", header: "Continue", options: [] }],
              signal: controller.signal,
            }),
          ).rejects.toThrow("fixture cancellation")
          expect(await Question.list()).toEqual([])
          expect(await Question.tryReply({ requestID, answers: [["late"]] })).toBe(false)
        } finally {
          unsubscribe()
        }
      },
    }),
  )
})
