import { expect, test } from "bun:test"
import type { NoteInfo, NotePatchInput } from "@ericsanchezok/synergy-sdk/client"
import { createNoteDocumentController } from "../../../src/components/note/document-controller"

const note = (id = "one", version = 1): NoteInfo => ({
  id,
  version,
  title: id,
  content: { type: "doc", content: [] },
  tags: [],
  pinned: false,
  global: false,
  archived: false,
  time: { created: 1, updated: 1 },
})

test("backup failure preserves edits and a retry reports durable recovery", async () => {
  let available = false
  let saved: unknown
  const document = createNoteDocumentController({
    id: "one",
    persist: (value) => {
      if (!available) throw new DOMException("quota", "QuotaExceededError")
      saved = value
    },
    update: async () => {
      throw new Error("Offline")
    },
  })
  document.ingest(note())
  document.edit("title", "Keep in memory")
  expect(document.backupUnavailable()).toBe(true)
  expect(document.title()).toBe("Keep in memory")
  expect(await document.flush()).toBe(false)
  available = true
  document.persist()
  expect(document.backupUnavailable()).toBe(false)
  expect(saved).toMatchObject({ title: "Keep in memory", base: { version: 1 } })
  document.dispose()
})

test("a deleted clean note can close while a deleted draft stays protected", async () => {
  const document = createNoteDocumentController({ id: "one", persist: () => {}, update: async () => note() })
  document.ingest(note())
  document.markDeleted()
  expect(await document.flush()).toBe(true)
  document.edit("title", "Recoverable draft")
  expect(await document.flush()).toBe(false)
  document.dispose()
})

test("a failed save retains the original baseline and draft through recovery", async () => {
  let persisted: unknown
  const first = createNoteDocumentController({
    id: "one",
    persist: (value) => (persisted = value),
    update: async () => {
      throw new Error("Disconnected")
    },
  })
  first.ingest(note())
  first.edit("title", "Unsent title")
  expect(await first.flush()).toBe(false)
  expect(first.base()?.version).toBe(1)
  const restored = createNoteDocumentController({
    id: "one",
    recover: persisted,
    persist: (value) => (persisted = value),
    update: async (patch) => ({ ...note("one", 2), title: patch.title ?? "one" }),
  })
  restored.ingest(note())
  expect(restored.title()).toBe("Unsent title")
  expect(await restored.flush()).toBe(true)
  expect(restored.dirty()).toEqual({ title: 0, tags: 0, content: 0 })
  first.dispose()
  restored.dispose()
})

test("an old save response cannot clear a later edit or change another document", async () => {
  let release!: (value: NoteInfo) => void
  const patches: NotePatchInput[] = []
  const one = createNoteDocumentController({
    id: "one",
    persist: () => {},
    update: async (patch) => {
      patches.push(patch)
      if (patches.length === 1) return new Promise<NoteInfo>((resolve) => (release = resolve))
      return { ...note("one", 3), title: patch.title! }
    },
  })
  const two = createNoteDocumentController({ id: "two", persist: () => {}, update: async () => note("two", 2) })
  one.ingest(note())
  two.ingest(note("two"))
  one.edit("title", "First")
  const save = one.flush()
  await Promise.resolve()
  one.edit("title", "Second")
  release({ ...note("one", 2), title: "First" })
  expect(await save).toBe(true)
  expect(one.title()).toBe("Second")
  expect(patches[1]).toMatchObject({ expectedVersion: 2, title: "Second" })
  expect(two.title()).toBe("two")
  one.dispose()
  two.dispose()
})

test("remote conflicting edits block replacement while disjoint metadata merges", async () => {
  const document = createNoteDocumentController({ id: "one", persist: () => {}, update: async () => note("one", 4) })
  document.ingest(note())
  document.edit("title", "Local")
  document.ingest({ ...note("one", 2), pinned: true }, ["pinned"])
  expect(document.conflict()).toBeNull()
  document.ingest({ ...note("one", 3), title: "Remote" }, ["title"])
  expect(await document.flush()).toBe(false)
  expect(document.title()).toBe("Local")
  expect(document.conflict()?.remote.title).toBe("Remote")
  document.markDeleted()
  expect(await document.flush()).toBe(false)
  expect(document.title()).toBe("Local")
  document.dispose()
})

test("metadata and document writes serialize without erasing edits made in flight", async () => {
  let remote = note()
  let release!: () => void
  const document = createNoteDocumentController({
    id: "one",
    persist: () => {},
    update: async (patch) => {
      if (patch.pinned) await new Promise<void>((resolve) => (release = resolve))
      expect(patch.expectedVersion).toBe(remote.version)
      remote = {
        ...remote,
        pinned: patch.pinned ?? remote.pinned,
        title: patch.title ?? remote.title,
        version: remote.version + 1,
      }
      return remote
    },
  })
  document.ingest(remote)
  const mutation = document.mutate((base) => ({ pinned: true, expectedVersion: base.version }))
  for (let i = 0; i < 5 && !release; i++) await Promise.resolve()
  document.edit("title", "During pin")
  release()
  expect(await mutation).toBe(true)
  expect(document.title()).toBe("During pin")
  expect(await document.flush()).toBe(true)
  expect(remote).toMatchObject({ title: "During pin", pinned: true })
  document.dispose()
})

test("a save event arriving before its response does not conflict with its own edit", async () => {
  let document: ReturnType<typeof createNoteDocumentController>
  document = createNoteDocumentController({
    id: "one",
    persist: () => {},
    update: async (patch) => {
      const saved = { ...note("one", 2), title: patch.title! }
      document.ingest(saved, ["title"])
      return saved
    },
  })
  document.ingest(note())
  document.edit("title", "Saved title")
  expect(await document.flush()).toBe(true)
  expect(document.conflict()).toBeNull()
  expect(document.base()?.version).toBe(2)
  document.dispose()
})

test("a newer foreign edit remains a conflict after the older save response", async () => {
  let document: ReturnType<typeof createNoteDocumentController>
  document = createNoteDocumentController({
    id: "one",
    persist: () => {},
    update: async (patch) => {
      document.edit("title", "Next local edit")
      document.ingest({ ...note("one", 3), title: "Other editor" }, ["title"])
      return { ...note("one", 2), title: patch.title! }
    },
  })
  document.ingest(note())
  document.edit("title", "First edit")
  expect(await document.flush()).toBe(false)
  expect(document.title()).toBe("Next local edit")
  expect(document.conflict()?.remote.title).toBe("Other editor")
  document.dispose()
})
