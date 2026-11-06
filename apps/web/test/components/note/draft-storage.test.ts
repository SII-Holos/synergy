import { expect, test } from "bun:test"
import { createNoteDocumentController } from "../../../src/components/note/document-controller"
import { createNoteDraftStorage } from "../../../src/components/note/draft-storage"

test("note recovery retains its baseline and cannot overwrite a competing window", () => {
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
  const target = { storage: "runtime-scope", key: "note:window:one" }
  const backup = createNoteDraftStorage(target, storage)
  const document = createNoteDocumentController({
    id: "one",
    persist: backup.write,
    update: async () => {
      throw new Error("Offline")
    },
  })
  document.ingest({
    id: "one",
    title: "Original",
    version: 1,
    content: { type: "doc", content: [] },
    tags: [],
    pinned: false,
    global: false,
    archived: false,
    time: { created: 1, updated: 1 },
  })
  document.edit("title", "Draft")
  const restored = createNoteDraftStorage(target, storage)
  expect(restored.draft).toMatchObject({ title: "Draft", base: { version: 1, title: "Original" } })
  expect(createNoteDraftStorage({ ...target, key: "note:second-window:one" }, storage).draft).toBeNull()
  values.set("runtime-scope:note:window:one", "competing backup")
  expect(backup.write(restored.draft)).toBe(false)
  expect(values.get("runtime-scope:note:window:one")).toBe("competing backup")
  document.dispose()
})

test("malformed recovery is preserved and reported as unavailable", () => {
  let value = "invalid"
  const backup = createNoteDraftStorage(
    { key: "note" },
    {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next
      },
      removeItem: () => {
        value = ""
      },
    },
  )
  expect(backup.available).toBe(false)
  expect(backup.write(null)).toBe(false)
  expect(value).toBe("invalid")
})
