import { test, expect } from "bun:test"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

async function interactiveSessionID() {
  const session = await Session.create({ interaction: SessionInteraction.interactive("test") })
  return session.id
}

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = Question.ask({
        sessionID: await interactiveSessionID(),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(promise).toBeInstanceOf(Promise)
    },
  })
})

test("ask - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      Question.ask({
        sessionID: await interactiveSessionID(),
        questions,
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      Question.ask({
        sessionID: await interactiveSessionID(),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Question.reply({
        requestID: "que_unknown",
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: await interactiveSessionID(),

        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reject(pending[0].id)
      askPromise.catch(() => {}) // Ignore rejection

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Question.reject("que_unknown")
      // Should not throw
    },
  })
})

// multiple questions tests

test("ask - rejects for unattended sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({
        interaction: SessionInteraction.unattended("agenda"),
      })

      await expect(
        Question.ask({
          sessionID: session.id,
          questions: [
            {
              question: "What would you like to do?",
              header: "Action",
              options: [{ label: "Option 1", description: "First option" }],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(Question.UnattendedError)

      expect(await Question.list()).toEqual([])
    },
  })
})

test("ask - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: await interactiveSessionID(),
        questions,
      })

      const pending = await Question.list()

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      Question.ask({
        sessionID: await interactiveSessionID(),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      Question.ask({
        sessionID: await interactiveSessionID(),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(2)
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})
