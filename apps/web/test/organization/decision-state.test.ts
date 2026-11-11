import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk"
mock.module("../../src/context/sdk", () => ({
  useSDK() {
    throw new Error("A personal client must not be acquired")
  },
}))
mock.module("../../src/context/global-sync", () => ({
  useGlobalSync() {
    throw new Error("Personal synchronization must not be acquired")
  },
}))
const { createSessionDecisionState } = await import("../../src/context/session-decision")
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
