import { afterEach, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

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
mock.module("@/context/global-sdk", () => ({ useGlobalSDK: () => ({ url: "http://note-runtime", client: {} }) }))
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
