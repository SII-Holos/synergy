import { createContext, createEffect, onCleanup, untrack, useContext, type ParentProps } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { z } from "zod"
import type { PermissionRequest, QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { useSDK, type SDKContext } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import type { QuestionSnapshotToken } from "./question-snapshot"
import { Persist, persisted } from "@/utils/persist"
import { createRequestSubmission } from "@/components/session/request-submission"
import {
  decisionIdentity,
  QuestionDraftSchema,
  sanitizeQuestionDraft,
  type QuestionDraft,
} from "@/components/session/question-prompt-model"

const DraftsSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), QuestionDraftSchema) })
type Drafts = z.infer<typeof DraftsSchema>
type Request = PermissionRequest | QuestionRequest
type RequestIdentity = Pick<Request, "id" | "sessionID">
type Kind = "question" | "permission"
type Reply = "once" | "session" | "always" | "reject"
type Operation = Parameters<ReturnType<typeof createRequestSubmission>["run"]>[1] & { settled?(): void }

export type DecisionRuntime = {
  serverURL: string
  scopeID: string
  client: SDKContext["client"]
  questions(): readonly QuestionRequest[]
  permissions(): readonly PermissionRequest[]
  questionSnapshot(): QuestionSnapshotToken | undefined
  captureQuestionSnapshot(): QuestionSnapshotToken
  seedQuestions(
    requests: readonly QuestionRequest[],
    headers: Headers | undefined,
    token: QuestionSnapshotToken,
  ): boolean
  seedPermissions(sessionID: string, requests: readonly PermissionRequest[], headers: Headers | undefined): void
}

export function createSessionDecisionState(runtime: DecisionRuntime) {
  const actions = createRequestSubmission()
  const operations = new Map<string, Operation>()
  const tracked = new Map<string, { request: RequestIdentity; kind: Kind }>()
  const [selected, setSelected] = createStore<Record<string, string>>({})
  const initial = createStore<Drafts>({ version: 1, entries: {} })
  const [drafts, setDrafts, , draftsReady] = (() => {
    try {
      return persisted<Drafts>(
        {
          ...Persist.workspace(Persist.scopeKey(runtime.serverURL, runtime.scopeID), "question-drafts-v1"),
          migrate: (value) => {
            const result = DraftsSchema.safeParse(value)
            return result.success ? result.data : { version: 1, entries: {} }
          },
        },
        initial,
      )
    } catch {
      return [initial[0], initial[1], undefined, () => true] as const
    }
  })()
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const draftKey = (request: RequestIdentity) => JSON.stringify([request.sessionID, request.id])
  const key = (kind: Kind, request: RequestIdentity) =>
    decisionIdentity({
      serverURL: runtime.serverURL,
      scopeID: runtime.scopeID,
      sessionID: request.sessionID,
      requestID: request.id,
      kind,
    })
  const clearDraft = (request: RequestIdentity) => {
    if (!alive) return
    setDrafts(
      "entries",
      produce((entries) => {
        delete entries[draftKey(request)]
      }),
    )
  }
  const draft = (request: QuestionRequest) => sanitizeQuestionDraft(request, drafts.entries[draftKey(request)])
  const updateDraft = (request: QuestionRequest, update: (previous: QuestionDraft) => QuestionDraft) => {
    if (!alive || !draftsReady()) return
    const next = sanitizeQuestionDraft(
      request,
      untrack(() => update(draft(request))),
    )
    setDrafts("entries", draftKey(request), reconcile(next))
  }

  createEffect(() => {
    const confirmed = runtime.questionSnapshot()
    const questions = runtime.questions()
    if (!confirmed || confirmed.scopeID !== runtime.scopeID || !draftsReady()) return
    const pendingQuestions = new Set(questions.map(draftKey))
    untrack(() => {
      setDrafts(
        "entries",
        produce((entries) => {
          for (const id of Object.keys(entries)) if (!pendingQuestions.has(id)) delete entries[id]
        }),
      )
      for (const [id, item] of tracked) {
        if (item.kind !== "question" || pendingQuestions.has(draftKey(item.request))) continue
        actions.forget(id)
        tracked.delete(id)
        operations.delete(id)
      }
    })
  })

  createEffect(() => {
    const pending = new Set(runtime.permissions().map(draftKey))
    for (const [id, item] of tracked) {
      if (item.kind !== "permission" || pending.has(draftKey(item.request)) || actions.state(id).status !== "settled")
        continue
      untrack(() => actions.forget(id))
      tracked.delete(id)
      operations.delete(id)
    }
  })

  const finish = (id: string, operation: Operation) => {
    if (alive && actions.state(id).status === "settled") {
      operation.settled?.()
      operations.delete(id)
    }
  }
  const run = async (kind: Kind, request: RequestIdentity, operation: Operation) => {
    const id = key(kind, request)
    if (
      !alive ||
      actions.state(id).status === "pending" ||
      actions.state(id).status === "unknown" ||
      actions.state(id).status === "settled"
    )
      return
    tracked.set(id, { request, kind })
    operations.set(id, operation)
    await actions.run(id, operation)
    finish(id, operation)
  }
  const questionPending = async (request: RequestIdentity) => {
    const token = runtime.captureQuestionSnapshot()
    const result = await runtime.client.question.list(undefined, { throwOnError: true })
    if (!result.data || !runtime.seedQuestions(result.data, result.response?.headers, token))
      throw new Error("Pending question could not be confirmed")
    return runtime.questions().some((item) => item.id === request.id && item.sessionID === request.sessionID)
  }
  const respondQuestion = (request: QuestionRequest, answers?: string[][]) => {
    const client = runtime.client
    const identity = { id: request.id, sessionID: request.sessionID }
    const captured = answers?.map((answer) => [...answer])
    return run("question", identity, {
      submit: () =>
        captured
          ? client.question.reply({ requestID: identity.id, answers: captured }, { throwOnError: true })
          : client.question.reject({ requestID: identity.id }, { throwOnError: true }),
      isPending: () => questionPending(identity),
      settled: () => clearDraft(identity),
    })
  }
  const respondPermission = (request: RequestIdentity, reply: Reply) => {
    const client = runtime.client
    const identity = { id: request.id, sessionID: request.sessionID }
    return run("permission", identity, {
      submit: () => client.permission.reply({ requestID: identity.id, reply }, { throwOnError: true }),
      isPending: async () => {
        const result = await client.permission.list({ sessionID: identity.sessionID }, { throwOnError: true })
        if (!result.data) throw new Error("Pending permission could not be confirmed")
        runtime.seedPermissions(identity.sessionID, result.data, result.response?.headers)
        return runtime.permissions().some((item) => item.id === identity.id && item.sessionID === identity.sessionID)
      },
    })
  }
  const retry = async (id: string) => {
    const operation = operations.get(id)
    if (!operation) return
    if (actions.state(id).status === "unknown") await actions.check(id, operation.isPending)
    else await actions.run(id, operation)
    finish(id, operation)
  }
  const ended = (kind: Kind, sessionID: string, requestID: string) => {
    const request = { id: requestID, sessionID }
    const id = decisionIdentity({ ...runtime, kind, sessionID, requestID })
    actions.settle(id)
    tracked.set(id, { request, kind })
    operations.delete(id)
    if (kind === "question") clearDraft(request)
  }

  return {
    key,
    draft,
    updateDraft,
    draftsReady,
    respondQuestion,
    respondPermission,
    retry,
    ended,
    state: actions.state,
    selection: (sessionID: string) => selected[sessionID],
    select: (sessionID: string, id: string) => setSelected(sessionID, id),
  }
}

export type SessionDecisionState = ReturnType<typeof createSessionDecisionState>
const Context = createContext<SessionDecisionState>()

export function SessionDecisionProvider(props: ParentProps<{ value?: SessionDecisionState }>) {
  const value =
    props.value ??
    (() => {
      const sdk = useSDK()
      const sync = useGlobalSync()
      const state = createSessionDecisionState({
        serverURL: sdk.url,
        scopeID: sdk.scopeID,
        client: sdk.client,
        questions: () => Object.values(sync.questions).flat(),
        permissions: () => Object.values(sync.permissions).flat(),
        questionSnapshot: () => sync.questionSnapshot(sdk.scopeID),
        captureQuestionSnapshot: () => sync.captureQuestionSnapshot(sdk.scopeID),
        seedQuestions: sync.seedGlobalQuestions,
        seedPermissions: (sessionID, requests, headers) =>
          sync.seedSessionPermissions(sessionID, requests, headers, sdk.scopeID),
      })
      const releases = [
        sdk.event.on("question.replied", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("question.rejected", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("question.timed_out", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("permission.replied", (event) =>
          state.ended("permission", event.properties.sessionID, event.properties.requestID),
        ),
      ]
      onCleanup(() => releases.forEach((release) => release()))
      return state
    })()
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useSessionDecision() {
  const value = useContext(Context)
  if (!value) throw new Error("SessionDecisionProvider is required")
  return value
}
