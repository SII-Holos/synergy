import { expect, test } from "bun:test"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { createQuestionDraftPortState, type QuestionDraftPort } from "../../src/context/question-draft-port"
import type { QuestionDraft } from "../../src/components/session/question-prompt-model"
const question = (id: string): QuestionRequest => ({
  id,
  sessionID: "session-one",
  questions: [{ header: "Answer", question: "Answer?", options: [] }],
})
const value = (text: string): QuestionDraft => ({ step: 0, selections: [[]], custom: [text], source: ["custom"] })
async function settle(ready: () => boolean) {
  for (let turn = 0; turn < 20 && !ready(); turn++) await Promise.resolve()
  expect(ready()).toBe(true)
}
test("only the active question hydrates and an obsolete point reply cannot replace its successor", async () => {
  const a = Promise.withResolvers<QuestionDraft>()
  const b = Promise.withResolvers<QuestionDraft>()
  const entered = Promise.withResolvers<void>()
  const reads: string[] = []
  const cancelled: string[] = []
  const port: QuestionDraftPort = {
    load: async (request, signal) => {
      reads.push(request.id)
      signal?.addEventListener("abort", () => cancelled.push(request.id), { once: true })
      if (request.id === "A") {
        entered.resolve()
        return a.promise
      }
      return b.promise
    },
    async save() {},
    async remove() {},
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    state.draft(question("A"))
    await entered.promise
    state.draft(question("B"))
    a.resolve(value("obsolete-body"))
    b.resolve(value("current-body"))
    await settle(() => state.ready(question("B")))
    expect(reads).toEqual(["A", "B"])
    expect(cancelled).toEqual(["A"])
    expect(state.draft(question("B")).custom).toEqual(["current-body"])
  } finally {
    state.dispose()
  }
})
test("typing coalesces one pending draft and changing questions waits for its durable latest value", async () => {
  const first = Promise.withResolvers<void>()
  const latest = Promise.withResolvers<void>()
  const reads: string[] = []
  const writes: string[] = []
  const port: QuestionDraftPort = {
    async load(request) {
      reads.push(request.id)
      return value("")
    },
    save: async (_request, draft) => {
      writes.push(draft.custom[0]!)
      return writes.length === 1 ? first.promise : latest.promise
    },
    async remove() {},
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    state.draft(question("A"))
    await settle(() => state.ready(question("A")))
    state.update(question("A"), () => value("one"))
    state.update(question("A"), () => value("two"))
    state.update(question("A"), () => value("three"))
    state.draft(question("B"))
    expect(reads).toEqual(["A"])
    expect(writes).toEqual(["one"])
    first.resolve()
    await settle(() => writes.length === 2)
    expect(writes).toEqual(["one", "three"])
    expect(reads).toEqual(["A"])
    latest.resolve()
    await settle(() => state.ready(question("B")))
    expect(reads).toEqual(["A", "B"])
  } finally {
    first.resolve()
    latest.resolve()
    state.dispose()
  }
})
test("owner cancellation releases secret input immediately while the ordinary captured write finishes before closing", async () => {
  const finish = Promise.withResolvers<void>()
  const controller = new AbortController()
  const writes: QuestionDraft[] = []
  let closed = false
  const port: QuestionDraftPort = {
    async load() {
      return value("")
    },
    async save(_request, draft) {
      writes.push(draft)
      await finish.promise
    },
    async remove() {},
    dispose() {
      closed = true
    },
  }
  const state = createQuestionDraftPortState(port, controller.signal)
  const request = { ...question("A"), questions: [{ ...question("A").questions[0]!, input_type: "password" as const }] }
  state.draft(request)
  await settle(() => state.ready(request))
  state.update(request, () => value("live-password"))
  expect(state.draft(request).custom).toEqual(["live-password"])
  expect(JSON.stringify(writes)).not.toContain("live-password")
  controller.abort()
  expect(state.draft(request).custom).toEqual([""])
  expect(closed).toBe(false)
  finish.resolve()
  await settle(() => closed)
  expect(writes[0]?.custom).toEqual([""])
})
test("explicit resolution removes its draft after an in-flight save without resurrecting a queued edit", async () => {
  const finish = Promise.withResolvers<void>()
  const events: string[] = []
  const port: QuestionDraftPort = {
    async load() {
      return value("")
    },
    async save(_request, draft) {
      events.push(draft.custom[0]!)
      await finish.promise
    },
    async remove(request) {
      events.push(`remove:${request.id}`)
    },
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    const request = question("A")
    state.draft(request)
    await settle(() => state.ready(request))
    state.update(request, () => value("one"))
    state.update(request, () => value("two"))
    const removal = state.clear(request)
    finish.resolve()
    await removal
    state.update(request, () => value("stale"))
    expect(events).toEqual(["one", "remove:A"])
  } finally {
    finish.resolve()
    state.dispose()
  }
})

test("native resolution still removes a saved draft when its in-flight replacement fails", async () => {
  const finish = Promise.withResolvers<void>()
  const events: string[] = []
  const port: QuestionDraftPort = {
    async load() {
      return value("previously-saved")
    },
    async save() {
      await finish.promise
      throw new Error("Write failed")
    },
    async remove(request) {
      events.push(`remove:${request.id}`)
    },
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    const request = question("A")
    state.draft(request)
    await settle(() => state.ready(request))
    state.update(request, () => value("replacement"))
    const removal = state.clear(request)
    finish.resolve()
    await removal
    expect(events).toEqual(["remove:A"])
    state.retry()
    await Promise.resolve()
    expect(events).toEqual(["remove:A"])
  } finally {
    finish.resolve()
    state.dispose()
  }
})

test("a persisted password is never restored even when a draft port returns one", async () => {
  const port: QuestionDraftPort = {
    async load() {
      return value("stored-password")
    },
    async save() {},
    async remove() {},
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  const request = { ...question("A"), questions: [{ ...question("A").questions[0]!, input_type: "password" as const }] }
  try {
    state.draft(request)
    await settle(() => state.ready(request))
    expect(state.draft(request).custom).toEqual([""])
  } finally {
    state.dispose()
  }
})

test("leaving a resolved question waits for its point deletion before closing the store", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let closed = false
  const port: QuestionDraftPort = {
    async load() {
      return value("saved answer")
    },
    async save() {},
    async remove() {
      entered.resolve()
      await finish.promise
    },
    dispose() {
      closed = true
    },
  }
  const state = createQuestionDraftPortState(port)
  state.draft(question("A"))
  await settle(() => state.ready(question("A")))
  const removed = state.clear(question("A"))
  await entered.promise
  state.dispose()
  await Promise.resolve()
  await Promise.resolve()
  expect(closed).toBe(false)
  finish.resolve()
  await removed
  await settle(() => closed)
})

test("reading a queued question's step never hydrates its body", () => {
  let reads = 0
  const port: QuestionDraftPort = {
    async load() {
      reads++
      return value("saved")
    },
    async save() {},
    async remove() {},
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    expect(state.step(question("cold-question"))).toBe(0)
    expect(reads).toBe(0)
  } finally {
    state.dispose()
  }
})

test("a failed point removal is retried by exact question identity after native resolution", async () => {
  const removed: string[] = []
  let attempts = 0
  const port: QuestionDraftPort = {
    async load() {
      return value("old answer")
    },
    async save() {},
    async remove(request) {
      removed.push(`${request.sessionID}:${request.id}`)
      if (++attempts === 1) throw new Error("Temporary delete failure")
    },
    dispose() {},
  }
  const state = createQuestionDraftPortState(port)
  try {
    const request = question("A")
    state.draft(request)
    await settle(() => state.ready(request))
    await state.clear(request)
    expect(state.error()).toBeDefined()
    state.retry()
    await settle(() => attempts === 2)
    expect(removed).toEqual(["session-one:A", "session-one:A"])
    await settle(() => state.error() === undefined)
  } finally {
    state.dispose()
  }
})

test("cleanup retry needs no active body and disposal retries a transient failed removal before closing", async () => {
  let attempts = 0
  let loads = 0
  let closed = false
  const port: QuestionDraftPort = {
    async load() {
      loads++
      return value("unused")
    },
    async save() {},
    async remove() {
      if (++attempts === 1) throw new Error("Temporary delete failure")
    },
    dispose() {
      closed = true
    },
  }
  const state = createQuestionDraftPortState(port)
  await state.clear({ id: "cold-question", sessionID: "session-one" })
  expect(state.error()).toBe("remove")
  state.dispose()
  await settle(() => closed)
  expect(attempts).toBe(2)
  expect(loads).toBe(0)
})
