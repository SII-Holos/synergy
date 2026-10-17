import { afterEach, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { NoteInfo } from "@ericsanchezok/synergy-sdk/client"

let value: unknown
mock.module("@ericsanchezok/synergy-ui/context", () => ({
  createSimpleContext: (input: { init: () => unknown }) => ({
    provider: () => {
      value = input.init()
      return null
    },
    use: () => value,
  }),
}))
mock.module("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ url: "http://note-runtime", client: {}, capabilities: { has: () => true } }),
}))
const { NoteDocumentsProvider, useNoteDocuments } = await import("../../../src/components/note/documents")
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  value = undefined
  localStorage.clear()
  sessionStorage.clear()
})

test("clean documents retain undo history while ordinary cached readers can be evicted", () => {
  const documents = createRoot((stop) => {
    dispose = stop
    NoteDocumentsProvider({ children: null })
    return useNoteDocuments()
  })
  const edited = documents.get("project", "edited")
  let history = true
  Object.assign(edited.view, { hasHistory: () => history })
  const reader = documents.get("project", "reader")
  for (let index = 0; index < 40; index++) documents.get("project", `other-${index}`)
  expect(documents.get("project", "edited")).toBe(edited)
  expect(documents.get("project", "reader")).not.toBe(reader)
  history = false
  for (let index = 0; index < 40; index++) documents.get("project", `next-${index}`)
  expect(documents.get("project", "edited")).not.toBe(edited)
})

test("preview lookup never creates a controller and exposes a current dirty draft over remote content", () => {
  const documents = createRoot((stop) => {
    dispose = stop
    NoteDocumentsProvider({ children: null })
    return useNoteDocuments()
  })
  expect(documents.peek("project", "note")).toBeUndefined()
  const controller = documents.get("project", "note")
  controller.setAvailable(false)
  controller.ingest({
    id: "note",
    title: "Base",
    version: 1,
    content: { type: "doc", content: [] },
    tags: [],
    pinned: false,
    global: false,
    archived: false,
    time: { created: 1, updated: 1 },
  } as NoteInfo)
  const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved draft" }] }] }
  controller.edit("content", draft)
  controller.ingest({ ...controller.base()!, version: 2, title: "Remote title" }, ["title"])
  expect(documents.peek("project", "note")).toBe(controller)
  expect(documents.peek("project", "note")?.content()).toEqual(draft)
  expect(controller.dirty().content).toBeGreaterThan(0)
  expect(documents.peek("other-project", "note")).toBeUndefined()
})
