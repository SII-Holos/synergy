import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { Data } from "@ericsanchezok/synergy-ui/context/data"
import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { createSessionTransitionState } from "../../src/context/session-transition"
import { createSessionSubmissionView, submissionPartPage } from "../../src/context/session-submission-view"
import { createNewSessionTransitionProgress } from "../../src/components/session/session-transition-progress"
import { createOptimisticUserMessage } from "../../src/components/prompt-input/optimistic-user-message"
import {
  createSubmissionPartIDs,
  createSubmissionParts,
  optimisticPartSummaries,
} from "../../src/components/prompt-input/submission-parts"
import { createMessageDisplayIdentity } from "../../src/context/message-display-identity"
import { isSessionSubmissionContentReady } from "../../src/components/session/session-transition-handoff"

test("file submissions retain their own workspace and encode reserved filename characters", () => {
  const workspace = { id: "wsp_original", generation: 2, root: "/original" }
  const parts = createSubmissionParts({
    id: createSubmissionPartIDs(),
    prompt: [{ type: "file", path: "文档/a #?%.ts", workspace, content: "@file", start: 0, end: 5 }],
    workspace: "/different",
    context: [],
    attachments: [],
    notes: [],
    sessions: [],
  })
  expect(parts.find((part) => part.type === "attachment")).toMatchObject({
    url: "file:///original/%E6%96%87%E6%A1%A3/a%20%23%3F%25.ts",
    source: { workspace, path: "/original/文档/a #?%.ts" },
  })
})

test("complete cached submission bodies cannot release the lease before scope recovery settles", () => {
  const message = {
    ...createOptimisticUserMessage({
      id: "message",
      sessionID: "session",
      created: 1,
      agent: "general",
      model: { providerID: "test", modelID: "test" },
    }),
    metadata: {},
  }
  const parts = [
    { id: "text", messageID: message.id, sessionID: message.sessionID, type: "text" as const, text: "Captured" },
  ]
  const summaries = optimisticPartSummaries(parts)
  const input = {
    message,
    captured: parts,
    summaries,
    parts,
    versions: Object.fromEntries(summaries.map((part) => [part.id, part.content.version])),
  }
  expect(isSessionSubmissionContentReady({ ...input, ready: false })).toBe(false)
  expect(isSessionSubmissionContentReady({ ...input, ready: true })).toBe(true)
})

test("captured submission stays local and yields to canonical messages and bodies without duplicating the root", () => {
  createRoot((dispose) => {
    const state = createSessionTransitionState()
    const lease = state.prepareDraft("draft")
    const [data, setData] = createStore<Data>({ session: [], message: {}, part: {}, session_diff: {} })
    const message = createOptimisticUserMessage({
      id: "message",
      sessionID: "session",
      created: 1,
      agent: "general",
      model: { modelID: "model", providerID: "provider" },
    })
    const parts = [
      { id: "part", messageID: message.id, sessionID: message.sessionID, type: "text" as const, text: "Captured" },
    ]
    lease.submit({ text: "Captured", messageID: message.id, prompt: [], message, parts })
    const view = createSessionSubmissionView(
      createSessionDataView(data),
      () => (state.get("session") ?? state.get("draft"))?.draft,
    )
    expect(view.messagesFor("session").map((item) => item.id)).toEqual(["message"])
    expect(view.messagesFor("other")).toHaveLength(0)
    expect(view.partsFor("message")[0]).toMatchObject({ text: "Captured" })
    expect(data.message.session).toBeUndefined()
    expect(data.part.message).toBeUndefined()
    lease.handoff("session", createNewSessionTransitionProgress())
    expect(view.messagesFor("session")).toHaveLength(1)
    setData("message", "session", [{ ...message, metadata: {} }])
    setData("part", "message", [{ ...parts[0], text: "Canonical" }])
    expect(view.messagesFor("session")).toHaveLength(1)
    expect(view.partsFor("message")[0]).toMatchObject({ text: "Canonical" })
    state.clear("session")
    expect(view.messagesFor("session")).toHaveLength(1)
    expect(view.partsFor("message")[0]).toMatchObject({ text: "Canonical" })
    dispose()
  })
})

test("preflight changes and workspace binding preserve part identities and the canonical text/attachment order", () => {
  const id = createSubmissionPartIDs()
  const input = {
    id,
    prompt: [{ type: "text" as const, content: "Hello", start: 0, end: 5 }],
    context: [],
    notes: [],
    sessions: [],
    attachments: [
      { type: "attachment" as const, id: "upload", mime: "image/png", url: "asset://image", filename: "image.png" },
    ],
  }
  const initial = createSubmissionParts(input)
  const validated = createSubmissionParts({
    ...input,
    prompt: [{ ...input.prompt[0], content: "Hello from preflight" }],
  })
  expect(validated.map((part) => part.id)).toEqual(initial.map((part) => part.id))
  expect(initial.map((part) => part.type)).toEqual(["text", "attachment"])
  const bodies = validated.map((part) => ({ ...part, sessionID: "session", messageID: "message" }))
  expect(optimisticPartSummaries(bodies).map((part) => part.id)).toEqual(bodies.map((part) => part.id).sort())
})

test("accepted message aliases preserve display identity only for the captured connection, scope and session", () => {
  const state = createMessageDisplayIdentity()
  const owner = ["server", "scope", "session"]
  state.handoff(owner, "optimistic", "canonical")
  expect(state.key(owner, "canonical")).toBe("optimistic")
  expect(state.key(["server", "other", "session"], "canonical")).toBe("canonical")
  expect(state.key(["other", "scope", "session"], "canonical")).toBe("canonical")
})

test("captured Parts do not hide an admitted root's missing canonical summary page", () => {
  const message = createOptimisticUserMessage({
    id: "message",
    sessionID: "session",
    created: 1,
    agent: "general",
    model: { modelID: "model", providerID: "provider" },
  })
  expect(submissionPartPage({ ready: true, captured: true, message })).toMatchObject({ hasMore: false })
  expect(submissionPartPage({ ready: false, captured: true, message: { ...message, metadata: {} } })).toMatchObject({
    hasMore: false,
  })
  expect(submissionPartPage({ ready: true, captured: true, message: { ...message, metadata: {} } })).toBeUndefined()
  const page = { hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null }
  expect(submissionPartPage({ ready: true, captured: true, message: { ...message, metadata: {} }, page })).toBe(page)
})

test("storage preparation exposes only captured content and partial canonical bodies retain their captured attachments", () => {
  createRoot((dispose) => {
    const message = createOptimisticUserMessage({
      id: "message",
      sessionID: "session",
      created: 1,
      agent: "general",
      model: { modelID: "model", providerID: "provider" },
    })
    const text = {
      id: "text",
      messageID: message.id,
      sessionID: message.sessionID,
      type: "text" as const,
      text: "Captured",
    }
    const image = {
      id: "image",
      messageID: message.id,
      sessionID: message.sessionID,
      type: "attachment" as const,
      mime: "image/png",
      url: "data:image/png;base64,fixture",
    }
    const [ready, setReady] = createSignal(false)
    const [data, setData] = createStore<Data>({
      session: [],
      message: {
        session: [{ ...message, metadata: {} }],
        history: [{ ...message, id: "private", sessionID: "history" }],
      },
      part: { message: [{ ...text, text: "Canonical" }], private: [{ ...text, messageID: "private" }] },
      session_diff: {},
    })
    const draft = { intent: 1, messageID: message.id, message, parts: [text, image] }
    const view = createSessionSubmissionView(createSessionDataView(data), () => draft, ready)
    expect(view.messagesFor("history")).toHaveLength(0)
    expect(view.partsFor("private")).toHaveLength(0)
    expect(view.partsFor(message.id).find((part) => part.type === "text")).toMatchObject({ text: "Captured" })
    setReady(true)
    expect(
      view
        .partsFor(message.id)
        .map((part) => part.id)
        .sort(),
    ).toEqual(["image", "text"])
    expect(view.partsFor(message.id).find((part) => part.type === "text")).toMatchObject({ text: "Canonical" })
    const summaries = optimisticPartSummaries([text, image])
    expect(
      isSessionSubmissionContentReady({
        ready: true,
        message,
        captured: draft.parts,
        summaries,
        parts: draft.parts,
        versions: Object.fromEntries(summaries.map((part) => [part.id, part.content.version])),
      }),
    ).toBe(false)
    const canonical = summaries.map((part) => ({ ...part, content: { ...part.content, version: "canonical" } }))
    expect(
      isSessionSubmissionContentReady({
        ready: true,
        message: { ...message, metadata: {} },
        captured: draft.parts,
        summaries: canonical,
        parts: data.part.message,
        versions: { text: "canonical", image: "canonical" },
      }),
    ).toBe(false)
    setData("part", "message", [text, image])
    expect(
      isSessionSubmissionContentReady({
        ready: true,
        message: { ...message, metadata: {} },
        captured: draft.parts,
        summaries,
        parts: data.part.message,
        versions: Object.fromEntries(summaries.map((part) => [part.id, part.content.version])),
      }),
    ).toBe(true)
    expect(
      isSessionSubmissionContentReady({
        ready: true,
        message: { ...message, metadata: {} },
        captured: draft.parts,
        summaries: canonical,
        parts: data.part.message,
        versions: { text: "canonical", image: "canonical" },
      }),
    ).toBe(true)
    dispose()
  })
})
