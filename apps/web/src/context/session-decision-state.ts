import { createEffect, onCleanup, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { z } from "zod"
import type { PermissionRequest, QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import type { QuestionSnapshotToken } from "./question-snapshot"
import { createQuestionDraftPortState, type QuestionDraftPort } from "./question-draft-port"
import { Persist, persisted } from "@/utils/persist"
import { createRequestSubmission } from "@/components/session/request-submission"
import {
  decisionIdentity,
  QuestionDraftSchema,
  sanitizeQuestionDraft,
  type QuestionDraft,
} from "@/components/session/question-prompt-model"

const DraftsV1 = z.object({ version: z.literal(1), entries: z.record(z.string(), QuestionDraftSchema) })
const InputType = z.enum(["text", "password"])
type Drafts = z.infer<typeof DraftsV1>
type Request = PermissionRequest | QuestionRequest
type RequestIdentity = Pick<Request, "id" | "sessionID">
type Kind = "question" | "permission"
type Reply = "once" | "session" | "always" | "reject"
type Operation = Parameters<ReturnType<typeof createRequestSubmission>["run"]>[1] & { settled?(): void }

export type DecisionRuntime = {
  connectionKey: string
  scopeID: string
  drafts?: QuestionDraftPort
  signal?: AbortSignal
  questions(): readonly QuestionRequest[]
  permissions(): readonly PermissionRequest[]
  questionSnapshot(): QuestionSnapshotToken | undefined
  replyQuestion(
    request: RequestIdentity,
    answers?: string[][],
    inputTypes?: readonly z.infer<typeof InputType>[],
  ): Promise<unknown>
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
  const pointDrafts = runtime.drafts ? createQuestionDraftPortState(runtime.drafts, runtime.signal) : undefined
  const initial = createStore<Drafts>({ version: 1, entries: {} })
  const [drafts, setDrafts, , legacyReady] = (() => {
    if (pointDrafts) return [initial[0], initial[1], undefined, () => true] as const
    try {
      return persisted<Drafts>(
        {
          ...Persist.workspace(Persist.scopeKey(runtime.connectionKey, runtime.scopeID), "question-drafts-v1"),
          migrate: (value) => {
            const result = DraftsV1.safeParse(value)
            if (!result.success) throw new Error("The saved question draft could not be read")
            return result.data
          },
        },
        initial,
      )
    } catch {
      return [initial[0], initial[1], undefined, () => true] as const
    }
  })()
  let alive = true
  const release = () => {
    alive = false
    operations.clear()
    tracked.clear()
    pointDrafts?.dispose()
    setSensitive(reconcile({}))
  }
  runtime.signal?.addEventListener("abort", release, { once: true })
  if (runtime.signal?.aborted) release()
  onCleanup(() => {
    runtime.signal?.removeEventListener("abort", release)
    release()
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
    if (pointDrafts) {
      void pointDrafts.clear(request)
      return
    }
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
  const inputTypes = (request: QuestionRequest) => request.questions.map((question) => question.input_type ?? "text")
  const restoreDraft = (request: QuestionRequest) =>
    redactedDraft(request, sanitizeQuestionDraft(request, drafts.entries[draftKey(request)]))
  const persistentDraft = (request: QuestionRequest, value: QuestionDraft) => redactedDraft(request, value)
  const draft = (request: QuestionRequest) => {
    if (pointDrafts) return pointDrafts.draft(request)
    const value = restoreDraft(request)
    return hasPassword(request) ? (sensitive[draftKey(request)] ?? redactedDraft(request, value)) : value
  }
  const updateDraft = (request: QuestionRequest, update: (previous: QuestionDraft) => QuestionDraft) => {
    if (!alive || actions.state(key("question", request)).status === "settled") return
    if (pointDrafts) {
      pointDrafts.update(request, update)
      return
    }
    if (!legacyReady()) return
    const next = sanitizeQuestionDraft(
      request,
      untrack(() => update(draft(request))),
    )
    if (hasPassword(request)) setSensitive(draftKey(request), reconcile(next))
    setDrafts("entries", draftKey(request), reconcile(persistentDraft(request, next)))
  }

  createEffect(() => {
    if (pointDrafts) return
    const questions = runtime.questions()
    if (!legacyReady()) return
    untrack(() => {
      for (const request of questions) {
        const stored = drafts.entries[draftKey(request)]
        if (!stored || !hasPassword(request)) continue
        const redacted = persistentDraft(request, restoreDraft(request))
        if (JSON.stringify(stored) !== JSON.stringify(redacted))
          setDrafts("entries", draftKey(request), reconcile(redacted))
      }
    })
  })

  createEffect(() => {
    if (pointDrafts) return
    const confirmed = runtime.questionSnapshot()
    const questions = runtime.questions()
    if (!confirmed || confirmed.scopeID !== runtime.scopeID || !legacyReady()) return
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
    const policy = inputTypes(request)
    return run("question", identity, {
      submit: () => runtime.replyQuestion(identity, captured, policy),
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
    draftStep: (request: QuestionRequest) => (pointDrafts ? pointDrafts.step(request) : draft(request).step),
    updateDraft,
    draftsReady: (request?: QuestionRequest) =>
      pointDrafts ? (request ? pointDrafts.ready(request) : true) : legacyReady(),
    draftError: () => pointDrafts?.error(),
    retryDraft: () => pointDrafts?.retry(),
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
