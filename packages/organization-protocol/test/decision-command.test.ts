import { expect, test } from "bun:test"
import { OrganizationCommandProtocol as Command } from "../src/index"

const request = {
  schemaVersion: 1 as const,
  orgID: "fixture-org",
  requestID: "logical-command",
  sessionID: "fixture-root",
  projectID: "fixture-project",
  runtimeID: "fixture-runtime",
  decision: {
    operation: "decision" as const,
    kind: "permission" as const,
    requestID: "native-pending",
    sourceSessionID: "fixture-child",
    reply: "always" as const,
  },
}

test("a decision digest binds its native pending identity, source, values and complete command target", async () => {
  const original = await Command.digestDecision(request)
  for (const changed of [
    { ...request, sessionID: "another-root" },
    { ...request, runtimeID: "another-runtime" },
    { ...request, requestID: "another-command" },
    { ...request, decision: { ...request.decision, requestID: "another-pending" } },
    { ...request, decision: { ...request.decision, sourceSessionID: "another-child" } },
    { ...request, decision: { ...request.decision, reply: "reject" as const } },
  ])
    expect(await Command.digestDecision(changed)).not.toBe(original)
  const question = {
    ...request,
    decision: {
      operation: "decision" as const,
      kind: "question" as const,
      requestID: "native-question",
      reply: "answer" as const,
      answers: [["first"]],
    },
  }
  expect(await Command.digestDecision(question)).not.toBe(
    await Command.digestDecision({ ...question, decision: { ...question.decision, answers: [["changed"]] } }),
  )
})

test("interactive commands reject forged authority, mismatched answer modes and native routing inputs", () => {
  expect(Command.DecisionRequest.parse(request)).toEqual(request)
  for (const decision of [
    { ...request.decision, actor: { subjectID: "forged" } },
    { ...request.decision, url: "https://caller-selected.invalid" },
    { ...request.decision, directory: "/caller-selected" },
    { operation: "decision", kind: "question", requestID: "native-question", reply: "answer" },
    {
      operation: "decision",
      kind: "question",
      requestID: "native-question",
      reply: "reject",
      answers: [["unexpected"]],
    },
  ])
    expect(Command.DecisionRequest.safeParse({ ...request, decision }).success).toBeFalse()
})
