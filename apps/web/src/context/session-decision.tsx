import { createContext, createEffect, onCleanup, untrack, useContext, type ParentProps } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { z } from "zod"
import type { PermissionRequest, QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
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
  connectionKey: string
  scopeID: string
  questions(): readonly QuestionRequest[]
  permissions(): readonly PermissionRequest[]
  questionSnapshot(): QuestionSnapshotToken | undefined
  replyQuestion(request: RequestIdentity, answers?: string[][]): Promise<unknown>
  replyPermission(request: RequestIdentity, reply: Reply): Promise<unknown>
  questionPending(request: RequestIdentity): Promise<boolean>
  permissionPending(request: RequestIdentity): Promise<boolean>
}

export function createSessionDecisionState(runtime: DecisionRuntime) {
  const actions = createRequestSubmission()
  const operations = new Map<string, Operation>()
  const tracked = new Map<string, { request: RequestIdentity; kind: Kind }>()
  const [selected, setSelected] = createStore<Record<string, string>>({})
  const [sensitive, setSensitive] = createStore<Record<string, QuestionDraft>>({})
  const initial = createStore<Drafts>({ version: 1, entries: {} })
  const [drafts, setDrafts, , draftsReady] = (() => {
    try {
      return persisted<Drafts>(
        {
          ...Persist.workspace(Persist.scopeKey(runtime.connectionKey, runtime.scopeID), "question-drafts-v1"),
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
      connectionKey: runtime.connectionKey,
      scopeID: runtime.scopeID,
      sessionID: request.sessionID,
      requestID: request.id,
      kind,
    })
  const clearDraft = (request: RequestIdentity) => {
    if (!alive) return
    setSensitive(
      produce((entries) => {
        delete entries[draftKey(request)]
      }),
    )
    setDrafts(
      "entries",
      produce((entries) => {
        delete entries[draftKey(request)]
      }),
    )
  }
  const redactedDraft = (request: QuestionRequest, value: QuestionDraft): QuestionDraft => ({
    ...value,
    custom: value.custom.map((answer, index) => (request.questions[index]?.input_type === "password" ? "" : answer)),
    selections: value.selections.map((answer, index) =>
      request.questions[index]?.input_type === "password" ? [] : answer,
    ),
    source: value.source.map((source, index) =>
      request.questions[index]?.input_type === "password" ? "custom" : source,
    ),
  })
  const hasPassword = (request: QuestionRequest) =>
    request.questions.some((question) => question.input_type === "password")
  const draft = (request: QuestionRequest) => {
    const value = sanitizeQuestionDraft(request, drafts.entries[draftKey(request)])
    return hasPassword(request) ? (sensitive[draftKey(request)] ?? redactedDraft(request, value)) : value
  }
  const updateDraft = (request: QuestionRequest, update: (previous: QuestionDraft) => QuestionDraft) => {
    if (!alive || !draftsReady()) return
    const next = sanitizeQuestionDraft(
      request,
      untrack(() => update(draft(request))),
    )
    if (hasPassword(request)) setSensitive(draftKey(request), reconcile(next))
    setDrafts("entries", draftKey(request), reconcile(redactedDraft(request, next)))
  }

  createEffect(() => {
    const questions = runtime.questions()
    if (!draftsReady()) return
    untrack(() => {
      for (const request of questions) {
        const stored = drafts.entries[draftKey(request)]
        if (!stored || !hasPassword(request)) continue
        const redacted = redactedDraft(request, sanitizeQuestionDraft(request, stored))
        if (JSON.stringify(stored) !== JSON.stringify(redacted))
          setDrafts("entries", draftKey(request), reconcile(redacted))
      }
    })
  })

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
      setSensitive(
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
  const respondQuestion = (request: QuestionRequest, answers?: string[][]) => {
    const identity = { id: request.id, sessionID: request.sessionID }
    const captured = answers?.map((answer) => [...answer])
    return run("question", identity, {
      submit: () => runtime.replyQuestion(identity, captured),
      isPending: () => runtime.questionPending(identity),
      settled: () => clearDraft(identity),
    })
  }
  const respondPermission = (request: RequestIdentity, reply: Reply) => {
    const identity = { id: request.id, sessionID: request.sessionID }
    return run("permission", identity, {
      submit: () => runtime.replyPermission(identity, reply),
      isPending: () => runtime.permissionPending(identity),
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
        connectionKey: sdk.cacheKey,
        scopeID: sdk.scopeID,
        questions: () => Object.values(sync.questions).flat(),
        permissions: () => Object.values(sync.permissions).flat(),
        questionSnapshot: () => sync.questionSnapshot(sdk.scopeID),
        replyQuestion: (request, answers) =>
          answers
            ? sdk.client.question.reply({ requestID: request.id, answers }, { throwOnError: true })
            : sdk.client.question.reject({ requestID: request.id }, { throwOnError: true }),
        replyPermission: (request, reply) =>
          sdk.client.permission.reply({ requestID: request.id, reply }, { throwOnError: true }),
        async questionPending(request) {
          const token = sync.captureQuestionSnapshot(sdk.scopeID)
          const result = await sdk.client.question.list(undefined, { throwOnError: true })
          if (!result.data || !sync.seedGlobalQuestions(result.data, result.response?.headers, token))
            throw new Error("Pending question could not be confirmed")
          return Object.values(sync.questions)
            .flat()
            .some((item) => item.id === request.id && item.sessionID === request.sessionID)
        },
        async permissionPending(request) {
          const result = await sdk.client.permission.list({ sessionID: request.sessionID }, { throwOnError: true })
          if (!result.data) throw new Error("Pending permission could not be confirmed")
          sync.seedSessionPermissions(request.sessionID, result.data, result.response?.headers, sdk.scopeID)
          return (sync.permissions[request.sessionID] ?? []).some(
            (item) => item.id === request.id && item.sessionID === request.sessionID,
          )
        },
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
