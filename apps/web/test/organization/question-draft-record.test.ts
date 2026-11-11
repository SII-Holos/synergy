import { expect, test } from "bun:test"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import {
  prepareOrganizationQuestionDraft,
  restoreOrganizationQuestionDraft,
  importOrganizationQuestionDraft,
} from "../../src/organization/question-draft-record"
const owner = {
  connectionKey: "connection-one",
  accountID: "account-one",
  projectID: "project-one",
}
const question: QuestionRequest = {
  id: "question-one",
  sessionID: "child-one",
  questions: [
    {
      header: "Document",
      question: "Which document?",
      options: [{ label: "Project", description: "Project document" }],
    },
    { header: "Password", question: "Password?", options: [], input_type: "password" },
  ],
}
const draft = {
  step: 1,
  selections: [["Project"], ["password-choice"]],
  custom: ["ordinary-body", "password-body"],
  source: ["custom", "custom"] as ("option" | "custom")[],
}
test("one question record retains its policy and ordinary value without any password answer", () => {
  const record = prepareOrganizationQuestionDraft(owner, question, draft)
  expect(record.inputTypes).toEqual(["text", "password"])
  expect(JSON.stringify(record)).not.toContain("password-body")
  expect(JSON.stringify(record)).not.toContain("password-choice")
  expect(restoreOrganizationQuestionDraft(owner, question, record).custom).toEqual(["ordinary-body", ""])
})
test("a point draft cannot restore under another owner or source or native question identity", () => {
  const record = prepareOrganizationQuestionDraft(owner, question, draft)
  for (const changed of [
    { ...owner, connectionKey: "other" },
    { ...owner, accountID: "other" },
    { ...owner, projectID: "other" },
  ])
    expect(() => restoreOrganizationQuestionDraft(changed, question, record)).toThrow()
  for (const changed of [
    { ...question, id: "other" },
    { ...question, sessionID: "other" },
  ])
    expect(() => restoreOrganizationQuestionDraft(owner, changed, record)).toThrow()
})
test("a changed step policy never upgrades an unclassified value into ordinary draft text", () => {
  const record = prepareOrganizationQuestionDraft(owner, question, draft)
  const changed: QuestionRequest = {
    ...question,
    questions: [
      { ...question.questions[0]!, input_type: "password" },
      { ...question.questions[1]!, input_type: "text" },
    ],
  }
  expect(restoreOrganizationQuestionDraft(owner, changed, record).custom).toEqual(["", ""])
  const bad = {
    ...record,
    inputTypes: ["password", "password"],
    draft: { ...record.draft, custom: ["unclassified-body", ""] },
  }
  expect(restoreOrganizationQuestionDraft(owner, question, bad).custom).toEqual(["", ""])
})

test("legacy migration does not infer a root or preserve text whose step policy is missing", () => {
  const record = importOrganizationQuestionDraft(owner, [question.sessionID, question.id], { ...draft, inputTypes: [] })
  expect(record.inputTypes).toEqual(["unknown", "unknown"])
  expect(record.draft.custom).toEqual(["", ""])
  expect(record).not.toHaveProperty("rootSessionID")
  expect(restoreOrganizationQuestionDraft(owner, question, record).custom).toEqual(["", ""])
})
