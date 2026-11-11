import { createStore, reconcile } from "solid-js/store"
import { untrack } from "solid-js"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { sanitizeQuestionDraft, type QuestionDraft } from "@/components/session/question-prompt-model"

export type QuestionDraftPort = {
  load(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionDraft | undefined>
  save(request: QuestionRequest, draft: QuestionDraft): Promise<void>
  remove(request: Pick<QuestionRequest, "sessionID" | "id">): Promise<void>
  dispose(): void
}
type Identity = Pick<QuestionRequest, "sessionID" | "id">
const key = (request: Identity) => JSON.stringify([request.sessionID, request.id])
const blank = (): QuestionDraft => ({ step: 0, selections: [], custom: [], source: [] })
const captured = (request: QuestionRequest): QuestionRequest => ({
  ...request,
  questions: request.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
  })),
})
function persistent(request: QuestionRequest, draft: QuestionDraft): QuestionDraft {
  return {
    ...draft,
    custom: draft.custom.map((value, index) => (request.questions[index]?.input_type === "password" ? "" : value)),
    selections: draft.selections.map((value, index) =>
      request.questions[index]?.input_type === "password" ? [] : value,
    ),
    source: draft.source.map((value, index) =>
      request.questions[index]?.input_type === "password" ? "custom" : value,
    ),
  }
}
export function createQuestionDraftPortState(port: QuestionDraftPort, signal?: AbortSignal) {
  const [state, setState] = createStore<{ draft: QuestionDraft; ready: boolean; error?: "load" | "save" | "remove" }>({
    draft: blank(),
    ready: false,
  })
  let active: string | undefined
  let target: QuestionRequest | undefined
  let loading: AbortController | undefined
  type Write = { request: QuestionRequest; draft: QuestionDraft; cancelled?: boolean }
  let queued: Write | undefined
  let writing: Write | undefined
  type Removal = { request: Identity; running?: Promise<void> }
  const removals = new Map<string, Removal>()
  const retirements = new Set<Promise<void>>()
  let flushing: Promise<void> | undefined
  let removed: string | undefined
  let alive = true
  let epoch = 0
  function drain(): Promise<void> {
    if (flushing) return flushing
    const pending = (async () => {
      while (queued) {
        const current = queued
        queued = undefined
        writing = current
        try {
          await port.save(current.request, current.draft)
        } catch (error) {
          if (current.cancelled) continue
          if (!queued) queued = current
          throw error
        } finally {
          if (writing === current) writing = undefined
        }
      }
    })()
    flushing = pending
    void pending
      .finally(() => {
        if (flushing === pending) flushing = undefined
      })
      .catch(() => {})
    return pending
  }
  function remove(identity: string, entry: Removal): Promise<void> {
    if (entry.running) return entry.running
    const work = (async () => {
      try {
        await drain().catch(() => {})
        await port.remove({ ...entry.request })
        if (removals.get(identity) === entry) removals.delete(identity)
        if (alive && state.error !== "save") setState("error", removals.size ? "remove" : undefined)
      } catch {
        if (alive) setState("error", "remove")
      }
    })()
    entry.running = work
    retirements.add(work)
    void work.finally(() => {
      if (entry.running === work) entry.running = undefined
      retirements.delete(work)
    })
    return work
  }
  const retryRemovals = () => Promise.all([...removals].map(([identity, entry]) => remove(identity, entry)))
  async function hydrate(request: QuestionRequest, version: number) {
    const controller = new AbortController()
    loading?.abort()
    loading = controller
    try {
      await retryRemovals()
      await drain()
      if (!alive || version !== epoch) return
      const value = await port.load(request, controller.signal)
      if (!alive || version !== epoch || controller.signal.aborted) return
      setState({
        draft: persistent(request, sanitizeQuestionDraft(request, value)),
        ready: true,
        error: removals.size ? "remove" : undefined,
      })
    } catch {
      if (alive && version === epoch && !controller.signal.aborted) setState("error", queued ? "save" : "load")
    }
  }
  function activate(request: QuestionRequest) {
    if (!alive) return
    const identity = key(request)
    if (active === identity) return
    active = identity
    removed = undefined
    target = captured(request)
    const version = ++epoch
    if (queued && key(queued.request) === identity) {
      setState({ draft: sanitizeQuestionDraft(request, queued.draft), ready: true, error: "save" })
      return
    }
    setState({ draft: sanitizeQuestionDraft(request, undefined), ready: false, error: undefined })
    void hydrate(target, version)
  }
  function dispose() {
    if (!alive) return
    alive = false
    epoch++
    loading?.abort()
    target = undefined
    active = undefined
    setState({ draft: blank(), ready: false, error: undefined })
    signal?.removeEventListener("abort", dispose)
    void drain()
      .catch(() => {})
      .then(() => Promise.allSettled([...retirements]))
      .then(() => retryRemovals())
      .finally(() => {
        queued = undefined
        removals.clear()
        port.dispose()
      })
  }
  signal?.addEventListener("abort", dispose, { once: true })
  if (signal?.aborted) dispose()
  return {
    step: (request: Identity) => (alive && active === key(request) ? state.draft.step : 0),
    draft(request: QuestionRequest) {
      activate(request)
      return alive && active === key(request) ? state.draft : sanitizeQuestionDraft(request, undefined)
    },
    ready(request: QuestionRequest) {
      activate(request)
      return alive && active === key(request) && state.ready
    },
    error: () => state.error,
    update(request: QuestionRequest, update: (draft: QuestionDraft) => QuestionDraft) {
      if (!alive || active !== key(request) || !state.ready || removed === active) return
      const value = sanitizeQuestionDraft(
        request,
        untrack(() => update(state.draft)),
      )
      setState("draft", reconcile(value))
      queued = { request: captured(request), draft: persistent(request, value) }
      void drain().then(
        () => {
          if (alive && active === key(request)) setState("error", removals.size ? "remove" : undefined)
        },
        () => {
          if (alive) setState("error", "save")
        },
      )
    },
    clear(request: Identity) {
      if (!alive) return Promise.resolve()
      const identity = key(request)
      if (writing && key(writing.request) === identity) writing.cancelled = true
      if (queued && key(queued.request) === identity) queued = undefined
      if (active === identity) {
        removed = identity
        epoch++
        loading?.abort()
        setState({ draft: blank(), ready: true, error: undefined })
      }
      const entry = removals.get(identity) ?? { request: { ...request } }
      removals.set(identity, entry)
      return remove(identity, entry)
    },
    retry() {
      if (!alive) return
      setState("error", undefined)
      if (!target || state.ready) {
        void retryRemovals()
          .then(() => drain())
          .then(
            () => {
              if (alive) setState("error", removals.size ? "remove" : undefined)
            },
            () => {
              if (alive) setState("error", "save")
            },
          )
        return
      }
      void hydrate(target, ++epoch)
    },
    dispose,
  }
}
