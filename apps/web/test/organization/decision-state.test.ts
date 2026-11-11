import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk"
import { createSessionDecisionState } from "../../src/context/session-decision-state"
const request: QuestionRequest = {
  id: "question-one",
  sessionID: "session-one",
  questions: [
    {
      header: "Destination",
      question: "Choose a destination",
      options: [{ label: "Project", description: "Use this project" }],
    },
  ],
}

test("an organization decision uses its own reply and confirms another winner without submitting twice", async () => {
  let calls = 0
  let pending = true
  const scope = createRoot((dispose) => ({
    dispose,
    state: createSessionDecisionState({
      connectionKey: "organization-a",
      scopeID: "project-one",
      questions: () => (pending ? [request] : []),
      permissions: () => [],
      questionSnapshot: () => undefined,
      async replyQuestion(value, answers) {
        expect(value).toMatchObject({ id: request.id, sessionID: request.sessionID })
        expect(answers).toEqual([["Project"]])
        calls++
        pending = false
        throw new Error("Receipt connection closed")
      },
      async replyPermission() {},
      async questionPending() {
        return pending
      },
      async permissionPending() {
        return false
      },
    }),
  }))
  try {
    await scope.state.respondQuestion(request, [["Project"]])
    expect(scope.state.state(scope.state.key("question", request)).status).toBe("settled")
    await scope.state.respondQuestion(request, [["Project"]])
    expect(calls).toBe(1)
  } finally {
    scope.dispose()
  }
})
test("an unknown decision checks the original pending request before allowing a retry", async () => {
  let calls = 0
  let unavailable = true
  const scope = createRoot((dispose) => ({
    dispose,
    state: createSessionDecisionState({
      connectionKey: "organization-a",
      scopeID: "project-one",
      questions: () => [request],
      permissions: () => [],
      questionSnapshot: () => undefined,
      async replyQuestion() {
        calls++
        throw new Error("Disconnected")
      },
      async replyPermission() {},
      async questionPending() {
        if (unavailable) throw new Error("Status unavailable")
        return false
      },
      async permissionPending() {
        return false
      },
    }),
  }))
  try {
    await scope.state.respondQuestion(request, [["Project"]])
    const key = scope.state.key("question", request)
    expect(scope.state.state(key).status).toBe("unknown")
    unavailable = false
    await scope.state.retry(key)
    expect(scope.state.state(key).status).toBe("settled")
    expect(calls).toBe(1)
  } finally {
    scope.dispose()
  }
})

test("password answers stay in the current decision state while ordinary answers survive a remount", async () => {
  localStorage.clear()
  const passwordRequest: QuestionRequest = {
    ...request,
    id: "password-question",
    questions: [
      { ...request.questions[0]!, input_type: "password" },
      { ...request.questions[0]!, header: "Ordinary answer" },
    ],
  }
  const runtime = {
    connectionKey: "password-organization",
    scopeID: "project-one",
    questions: () => [passwordRequest],
    permissions: () => [],
    questionSnapshot: () => undefined,
    async replyQuestion() {},
    async replyPermission() {},
    async questionPending() {
      return true
    },
    async permissionPending() {
      return true
    },
  }
  const first = createRoot((dispose) => ({ dispose, state: createSessionDecisionState(runtime) }))
  first.state.updateDraft(passwordRequest, (draft) => ({
    ...draft,
    custom: ["private-password-answer", "Retained ordinary answer"],
    source: ["custom", "custom"],
  }))
  await Promise.resolve()
  expect(first.state.draft(passwordRequest).custom).toEqual(["private-password-answer", "Retained ordinary answer"])
  expect(Object.values(localStorage).join(" ")).not.toContain("private-password-answer")
  first.dispose()
  expect(first.state.draft(passwordRequest).custom[0]).toBe("")
  const second = createRoot((dispose) => ({ dispose, state: createSessionDecisionState(runtime) }))
  try {
    expect(second.state.draft(passwordRequest).custom).toEqual(["", "Retained ordinary answer"])
  } finally {
    second.dispose()
    localStorage.clear()
  }
})

test("organization question drafts use a policy-bearing v2 namespace and never restore a mismatched step", async () => {
  localStorage.clear()
  const question: QuestionRequest = {
    ...request,
    id: "v2-question",
    questions: [{ ...request.questions[0]! }, { ...request.questions[0]!, input_type: "password" }],
  }
  const runtime = {
    connectionKey: "organization-v2",
    scopeID: "project-one",
    draftStore: "organization-v2" as const,
    questions: () => [question],
    permissions: () => [],
    questionSnapshot: () => undefined,
    async replyQuestion() {},
    async replyPermission() {},
    async questionPending() {
      return true
    },
    async permissionPending() {
      return true
    },
  }
  const scope = createRoot((dispose) => ({ dispose, state: createSessionDecisionState(runtime) }))
  scope.state.updateDraft(question, (draft) => ({
    ...draft,
    custom: ["Ordinary answer", "Volatile password"],
    source: ["custom", "custom"],
  }))
  await Promise.resolve()
  const key = Object.keys(localStorage).find((key) => key.includes("question-drafts-v2"))
  expect(key).toBeDefined()
  const raw = localStorage.getItem(key!)!
  const stored = JSON.parse(raw)
  expect(stored.version).toBe(2)
  const entry = stored.entries[JSON.stringify([question.sessionID, question.id])]
  expect(entry.inputTypes).toEqual(["text", "password"])
  expect(raw).not.toContain("Volatile password")
  scope.dispose()
  entry.inputTypes[0] = "password"
  entry.custom[0] = "Unclassified sensitive value"
  localStorage.setItem(key!, JSON.stringify(stored))
  const restored = createRoot((dispose) => ({ dispose, state: createSessionDecisionState(runtime) }))
  try {
    expect(restored.state.draft(question).custom[0]).toBe("")
  } finally {
    restored.dispose()
    localStorage.clear()
  }
})
test("a cached question action passes its captured password policy independently of the current pending page", async () => {
  const question: QuestionRequest = { ...request, questions: [{ ...request.questions[0]!, input_type: "password" }] }
  let policy: readonly ("text" | "password")[] | undefined
  const scope = createRoot((dispose) => ({
    dispose,
    state: createSessionDecisionState({
      connectionKey: "policy-capture",
      scopeID: "project-one",
      questions: () => [],
      permissions: () => [],
      questionSnapshot: () => undefined,
      async replyQuestion(_identity, _answers, inputTypes) {
        policy = inputTypes
      },
      async replyPermission() {},
      async questionPending() {
        return false
      },
      async permissionPending() {
        return false
      },
    }),
  }))
  try {
    await scope.state.respondQuestion(question, [["secret-answer"]])
    expect(policy).toEqual(["password"])
  } finally {
    scope.dispose()
  }
})

test("an aborted organization owner releases password drafts before its component unmounts", async () => {
  const controller = new AbortController()
  const question: QuestionRequest = {
    ...request,
    id: "aborted-password",
    questions: [{ ...request.questions[0]!, input_type: "password" }],
  }
  let replies = 0
  const scope = createRoot((dispose) => ({
    dispose,
    state: createSessionDecisionState({
      connectionKey: "abort-password",
      scopeID: "project-one",
      draftStore: "organization-v2",
      signal: controller.signal,
      questions: () => [question],
      permissions: () => [],
      questionSnapshot: () => undefined,
      async replyQuestion() {
        replies++
      },
      async replyPermission() {},
      async questionPending() {
        return true
      },
      async permissionPending() {
        return true
      },
    }),
  }))
  try {
    scope.state.updateDraft(question, (draft) => ({ ...draft, custom: ["volatile-owner-secret"], source: ["custom"] }))
    expect(scope.state.draft(question).custom).toEqual(["volatile-owner-secret"])
    controller.abort()
    expect(scope.state.draft(question).custom).toEqual([""])
    await scope.state.respondQuestion(question, [["obsolete-answer"]])
    expect(replies).toBe(0)
  } finally {
    scope.dispose()
  }
})

test("a Main permission denial invalidates the interaction owner and releases its still-mounted password draft", async () => {
  const { createOrganizationInteractionRuntime } = await import("../../src/organization/interaction-runtime")
  const { createOrganizationClient } = await import("@ericsanchezok/synergy-sdk/organization")
  const question: QuestionRequest = {
    ...request,
    id: "denied-password",
    questions: [{ ...request.questions[0]!, input_type: "password" }],
  }
  const scope = createRoot((dispose) => ({
    dispose,
    runtime: createOrganizationInteractionRuntime({
      api: createOrganizationClient({ baseUrl: "https://organization.example" }),
      accountID: "account-one",
      connectionKey: "denied-owner",
      rootSessionID: "session-one",
      binding: {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      },
      signal: new AbortController().signal,
    }),
  }))
  try {
    scope.runtime.decisions.updateDraft(question, (draft) => ({
      ...draft,
      custom: ["denied-volatile-secret"],
      source: ["custom"],
    }))
    scope.runtime.fail({ code: "permission_denied" })
    expect(scope.runtime.active()).toBe(false)
    expect(scope.runtime.decisions.draft(question).custom).toEqual([""])
  } finally {
    scope.dispose()
  }
})
