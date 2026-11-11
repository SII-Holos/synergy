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
  const second = createRoot((dispose) => ({ dispose, state: createSessionDecisionState(runtime) }))
  try {
    expect(second.state.draft(passwordRequest).custom).toEqual(["", "Retained ordinary answer"])
  } finally {
    second.dispose()
    localStorage.clear()
  }
})

test("a finite pending page cannot confirm a lost response, while an explicit native winner is shown separately from the logical receipt", async () => {
  const { createOrganizationInteractionRuntime } = await import("../../src/organization/interaction-runtime")
  const { createOrganizationClient } = await import("@ericsanchezok/synergy-sdk/organization")
  const binding = {
    schemaVersion: 1,
    orgID: "org-one",
    projectID: "project-one",
    creatorID: "account-one",
    driverRuntimeID: "runtime-one",
    bindingEpoch: 1,
  } as const
  const native = {
    kind: "question",
    requestID: "native-one",
    sourceSessionID: "session-one",
    questions: [{ header: "Password", question: "Enter a password", options: [], input_type: "password" }],
  } as const
  let phase: "pending" | "missing-page" | "resolved" = "pending"
  let submitted = 0
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const api = createOrganizationClient({
    baseUrl: "https://organization.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        const url = new URL(request.url)
        if (url.pathname.endsWith("/interactions/reply")) {
          submitted++
          return Response.json({ code: "COMMAND_OUTCOME_UNKNOWN" }, { status: 504 })
        }
        if (url.pathname.includes("/commands/"))
          return Response.json({
            requestID: url.pathname.split("/").at(-1),
            attemptID: "attempt",
            state: "unknown",
            authorizedAt: 1,
          })
        const query = await request.json()
        const envelope = {
          rootSessionID: "session-one",
          sourceSessionID: "session-one",
          binding,
          runtimeKind: "hosted",
        }
        if (query.operation === "pending")
          return Response.json({
            ...envelope,
            operation: "pending",
            items: phase === "pending" ? [native] : [],
            hasMore: false,
          })
        return Response.json({
          ...envelope,
          operation: "decisions",
          items: [
            phase === "resolved"
              ? {
                  identity: { kind: "question", requestID: "native-one" },
                  state: "resolved",
                  winner: {
                    sessionID: "session-one",
                    requestID: "native-one",
                    decidedAt: 2,
                    actor: {
                      kind: "account",
                      subjectID: "another-account",
                      displayName: "Another member",
                      clientKind: "web",
                      requestID: "another-logical",
                      orgID: "org-one",
                    },
                    outcome: { kind: "question", reply: "answer" },
                  },
                }
              : { identity: { kind: "question", requestID: "native-one" }, state: "pending" },
          ],
        })
      },
      { preconnect() {} },
    ),
  })
  const current = createRoot((dispose) => ({
    dispose,
    runtime: createOrganizationInteractionRuntime({
      api,
      accountID: "account-one",
      connectionKey: "connection-one",
      rootSessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      storage,
    }),
  }))
  try {
    await current.runtime.load()
    const question = {
      id: native.requestID,
      sessionID: "session-one",
      questions: [...native.questions].map((item) => ({ ...item, options: [] })),
    }
    await current.runtime.decisions.respondQuestion(question, [["private-answer"]])
    expect(submitted).toBe(1)
    expect(current.runtime.decisions.state(current.runtime.decisions.key("question", question)).status).toBe("unknown")
    expect([...values.values()].join(" ")).not.toContain("private-answer")
    phase = "missing-page"
    await current.runtime.load()
    expect(current.runtime.state.retained).toHaveLength(1)
    expect(current.runtime.decisions.state(current.runtime.decisions.key("question", question)).status).toBe("unknown")
    phase = "resolved"
    await current.runtime.check(current.runtime.state.retained[0]!)
    expect(current.runtime.notice()).toMatchObject({
      state: "resolved",
      winner: { actor: { displayName: "Another member" } },
    })
    expect(current.runtime.state.retained).toHaveLength(1)
    expect(current.runtime.state.retained[0]?.command).toBeUndefined()
    expect(submitted).toBe(1)
  } finally {
    current.dispose()
  }
  phase = "pending"
  const reloaded = createRoot((dispose) => ({
    dispose,
    runtime: createOrganizationInteractionRuntime({
      api,
      accountID: "account-one",
      connectionKey: "connection-one",
      rootSessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      storage,
    }),
  }))
  try {
    await reloaded.runtime.load()
    expect(reloaded.runtime.visible()).toHaveLength(0)
    expect(reloaded.runtime.blocked()).toHaveLength(1)
    await reloaded.runtime.check(reloaded.runtime.state.retained[0]!, true)
    expect(submitted).toBe(1)
    expect(reloaded.runtime.state.retained[0]?.command).toBeUndefined()
  } finally {
    reloaded.dispose()
  }
})

test("pending pagination can pass the residency window while retaining the selected request", async () => {
  const { createOrganizationInteractionRuntime } = await import("../../src/organization/interaction-runtime")
  const { createOrganizationClient } = await import("@ericsanchezok/synergy-sdk/organization")
  const binding = {
    schemaVersion: 1,
    orgID: "org-one",
    projectID: "project-one",
    creatorID: "account-one",
    driverRuntimeID: "runtime-one",
    bindingEpoch: 1,
  } as const
  let page = 0
  const api = createOrganizationClient({
    baseUrl: "https://organization.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        const query = await request.json()
        const start = query.cursor ? Number(query.cursor) : 0
        page = start / 32
        return Response.json({
          rootSessionID: "session-one",
          sourceSessionID: "session-one",
          binding,
          runtimeKind: "member",
          operation: "pending",
          items: Array.from({ length: 32 }, (_, index) => ({
            kind: "permission",
            requestID: `permission-${start + index}`,
            sourceSessionID: "session-one",
            permission: "bash",
            patterns: [],
            alwaysScope: "runtime",
          })),
          hasMore: true,
          cursor: String(start + 32),
        })
      },
      { preconnect() {} },
    ),
  })
  const scope = createRoot((dispose) => ({
    dispose,
    runtime: createOrganizationInteractionRuntime({
      api,
      accountID: "account-one",
      connectionKey: "large-pending",
      rootSessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      storage: localStorage,
    }),
  }))
  try {
    await scope.runtime.load()
    scope.runtime.decisions.select(
      "session-one",
      scope.runtime.decisions.key("permission", { id: "permission-0", sessionID: "session-one" }),
    )
    for (let index = 0; index < 4; index++) await scope.runtime.load(true)
    expect(page).toBe(4)
    expect(scope.runtime.visible()).toHaveLength(128)
    expect(scope.runtime.visible().some((entry) => entry.requestID === "permission-159")).toBe(true)
    expect(scope.runtime.visible().some((entry) => entry.requestID === "permission-0")).toBe(true)
    await scope.runtime.load(false, true)
    expect(scope.runtime.cursor()).toBe("160")
  } finally {
    scope.dispose()
  }
})
