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
  const failures: unknown[] = []
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
      invalidated: (error) => failures.push(error),
    }),
  }))
  try {
    scope.runtime.decisions.updateDraft(question, (draft) => ({
      ...draft,
      custom: ["denied-volatile-secret"],
      source: ["custom"],
    }))
    scope.runtime.fail({ code: "permission_denied" })
    expect(failures).toEqual([{ code: "permission_denied" }])
    expect(scope.runtime.active()).toBe(false)
    expect(scope.runtime.decisions.draft(question).custom).toEqual([""])
  } finally {
    scope.dispose()
  }
})

test("the shared question model uses its supplied point port without opening a legacy project draft record", async () => {
  const loaded =
    Promise.withResolvers<
      ReturnType<typeof import("../../src/components/session/question-prompt-model").sanitizeQuestionDraft>
    >()
  let reads = 0
  let writes = 0
  const original = Storage.prototype.getItem
  let legacyReads = 0
  Storage.prototype.getItem = function (name) {
    if (name.includes("question-drafts")) legacyReads++
    return original.call(this, name)
  }
  const scope = createRoot((dispose) => ({
    dispose,
    state: createSessionDecisionState({
      connectionKey: "point-model",
      scopeID: "project-one",
      drafts: {
        async load() {
          reads++
          return loaded.promise
        },
        async save() {
          writes++
        },
        async remove() {},
        dispose() {},
      },
      questions: () => [request],
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
    }),
  }))
  try {
    expect(scope.state.draftsReady(request)).toBe(false)
    scope.state.draft(request)
    loaded.resolve({ step: 0, custom: ["saved answer"], selections: [[]], source: ["custom"] })
    for (let turn = 0; turn < 20 && !scope.state.draftsReady(request); turn++) await Promise.resolve()
    expect(scope.state.draft(request).custom).toEqual(["saved answer"])
    expect(reads).toBe(1)
    expect(legacyReads).toBe(0)
    scope.state.updateDraft(request, (draft) => ({ ...draft, custom: ["updated answer"] }))
    for (let turn = 0; turn < 20 && !writes; turn++) await Promise.resolve()
    expect(writes).toBe(1)
  } finally {
    scope.dispose()
    Storage.prototype.getItem = original
  }
})
