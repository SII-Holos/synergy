import { expect, test } from "bun:test"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import {
  questionAnswers,
  sanitizeQuestionDraft,
  decisionIdentity,
} from "../../../src/components/session/question-prompt-model"

const request: QuestionRequest = {
  id: "q1",
  sessionID: "s1",
  questions: [
    {
      header: "First",
      question: "Pick one",
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    },
    { header: "Second", question: "Pick several", multiple: true, options: [{ label: "C", description: "" }] },
  ],
}

test("multi-choice supplements join the selected labels in one answer", () => {
  const draft = sanitizeQuestionDraft(request, {
    step: 1,
    selections: [["A"], ["C"]],
    custom: ["", "  More context  "],
    source: ["option", "option"],
  })
  expect(questionAnswers(request, draft)).toEqual([["A"], ["C", "More context"]])
})

test("single-choice source is exclusive without discarding the other draft", () => {
  const draft = sanitizeQuestionDraft(request, {
    step: 0,
    selections: [["B"], []],
    custom: ["  My answer  ", ""],
    source: ["custom", "option"],
  })
  expect(questionAnswers(request, draft)[0]).toEqual(["My answer"])
  expect(draft.selections[0]).toEqual(["B"])
  expect(questionAnswers(request, { ...draft, source: ["option", "option"] })[0]).toEqual(["B"])
})

test("restoring a draft validates the step and labels against the live request", () => {
  const draft = sanitizeQuestionDraft(request, {
    step: 99,
    selections: [["removed", "A", "B"], ["removed"]],
    custom: ["", " "],
    source: ["option", "custom"],
  })
  expect(draft.step).toBe(1)
  expect(questionAnswers(request, draft)).toEqual([["A"], []])
  expect(sanitizeQuestionDraft(request, { step: "bad" }).step).toBe(0)
})

test("decision identity isolates servers, Scopes and request kinds", () => {
  const identity = {
    serverURL: "http://a",
    scopeID: "scope",
    sessionID: "s1",
    requestID: "q1",
    kind: "question" as const,
  }
  const keys = [
    decisionIdentity(identity),
    decisionIdentity({ ...identity, serverURL: "http://b" }),
    decisionIdentity({ ...identity, scopeID: "other" }),
    decisionIdentity({ ...identity, kind: "permission" }),
  ]
  expect(new Set(keys).size).toBe(4)
})
