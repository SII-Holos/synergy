import { expect, test } from "bun:test"
import { createFileDraftStorage, type FileDraft } from "../../../src/context/file/draft-storage"

const target = { storage: "connection-scope-workspace-generation", key: "drafts" }
const key = `${target.storage}:${target.key}`
const draft: FileDraft = {
  content: "\ufeffedited\r\n",
  baseContent: "\ufeffbase\r\n",
  expectedVersion: `sha256:${"a".repeat(64)}`,
  revision: 7,
}
function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
  }
}

test("draft backups preserve exact text and revision, and delete only after the edits are settled", () => {
  const disk = storage()
  const owner = createFileDraftStorage(target, disk)
  expect(owner.write({ "file.txt": draft })).toBe(true)
  expect(createFileDraftStorage(target, disk).drafts).toEqual({ "file.txt": draft })
  expect(createFileDraftStorage({ ...target, storage: "new-generation" }, disk).drafts).toEqual({})
  expect(owner.write({ "file.txt": { ...draft, content: draft.baseContent } })).toBe(true)
  expect(disk.values.has(key)).toBe(false)
})

test("quota errors retain the last durable backup and the same owner can retry", () => {
  const disk = storage()
  const owner = createFileDraftStorage(target, disk)
  expect(owner.write({ "file.txt": draft })).toBe(true)
  const saved = disk.values.get(key)
  const write = disk.setItem
  disk.setItem = () => {
    throw new DOMException("full", "QuotaExceededError")
  }
  const next = { ...draft, content: "more work", revision: 8 }
  expect(owner.write({ "file.txt": next })).toBe(false)
  expect(disk.values.get(key)).toBe(saved)
  disk.setItem = write
  expect(owner.write({ "file.txt": next })).toBe(true)
  expect(createFileDraftStorage(target, disk).drafts["file.txt"]).toEqual(next)
})

test("a stale editor cannot replace another window's durable backup", () => {
  const disk = storage()
  const first = createFileDraftStorage(target, disk),
    second = createFileDraftStorage(target, disk)
  expect(first.write({ "file.txt": draft })).toBe(true)
  expect(second.write({ "file.txt": { ...draft, content: "other" } })).toBe(false)
  expect(createFileDraftStorage(target, disk).drafts["file.txt"]).toEqual(draft)
})

for (const raw of [
  "{",
  JSON.stringify({ version: 2, drafts: {} }),
  JSON.stringify({ version: 1, drafts: { "../outside": draft } }),
  JSON.stringify({ version: 1, drafts: { "file.txt": { ...draft, expectedVersion: "mtime:1" } } }),
]) {
  test("invalid persisted drafts are retained for recovery and never become write authority", () => {
    const disk = storage()
    disk.values.set(key, raw)
    const owner = createFileDraftStorage(target, disk)
    expect(owner.drafts).toEqual({})
    expect(owner.available()).toBe(false)
    expect(owner.write({ "file.txt": draft })).toBe(false)
    expect(disk.values.get(key)).toBe(raw)
  })
}

test("unavailable storage and bounded backup overflow remain explicit", () => {
  const disk = storage()
  disk.getItem = () => {
    throw new DOMException("blocked", "SecurityError")
  }
  const blocked = createFileDraftStorage(target, disk)
  expect(blocked.available()).toBe(false)
  expect(blocked.write({ "file.txt": draft })).toBe(false)
  const owner = createFileDraftStorage(target, storage())
  expect(owner.write(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`${index}.txt`, draft])))).toBe(
    false,
  )
})
