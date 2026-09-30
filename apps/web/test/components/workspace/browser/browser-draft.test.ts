import { beforeEach, expect, mock, test } from "bun:test"
import type { Prompt, UploadedAttachmentPart } from "../../../../src/context/prompt"

let sessionID = "task-one"
let ready = true
let current = true
let parts: Prompt = []
const writes: Prompt[] = []
const uploads: unknown[] = []
const release = mock(() => {})
const capture = mock(() => ({
  draft: {
    ready: () => ready,
    current: () => parts,
    set: (value: Prompt) => {
      parts = value
      writes.push(value)
    },
  },
  isCurrent: () => current,
  release,
}))

mock.module("@solidjs/router", () => ({
  useParams: () => ({
    get id() {
      return sessionID
    },
  }),
}))
mock.module("../../../../src/context/prompt", () => ({ usePrompt: () => ({ capture }) }))
mock.module("../../../../src/context/sdk", () => ({
  useSDK: () => ({
    client: {
      asset: {
        upload: async (input: { file?: unknown }) => {
          uploads.push(input.file)
          return { data: { url: "asset://browser-export", mime: "text/csv", size: 4 } }
        },
      },
    },
  }),
}))

const { useBrowserDraft } = await import("../../../../src/components/workspace/browser/browser-draft")
const artifact = { filename: "page.pdf", mime: "application/pdf", url: "asset://page" }

beforeEach(() => {
  sessionID = "task-one"
  ready = true
  current = true
  parts = []
  writes.length = 0
  uploads.length = 0
  capture.mockClear()
  release.mockClear()
})

test("a browser result cannot attach to a different conversation", async () => {
  const load = mock(async () => artifact)
  await expect(useBrowserDraft("task-other").artifact(load)).rejects.toThrow("original conversation")
  expect(load).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  expect(writes).toEqual([])
})

test("an unloaded draft rejects before loading the result and releases its capture", async () => {
  ready = false
  const load = mock(async () => artifact)
  await expect(useBrowserDraft(sessionID).artifact(load)).rejects.toThrow("draft to load")
  expect(load).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
})

test("switching conversations while loading leaves both drafts untouched", async () => {
  const pending = Promise.withResolvers<typeof artifact>()
  const append = useBrowserDraft(sessionID).artifact(() => pending.promise)
  current = false
  sessionID = "task-two"
  pending.resolve(artifact)
  await expect(append).rejects.toThrow("conversation changed")
  expect(writes).toEqual([])
  expect(release).toHaveBeenCalledTimes(1)
})

test("loading failures release the draft and retain the actionable error", async () => {
  const error = new Error("Download is not ready")
  await expect(
    useBrowserDraft(sessionID).artifact(async () => {
      throw error
    }),
  ).rejects.toBe(error)
  expect(writes).toEqual([])
  expect(release).toHaveBeenCalledTimes(1)
})

test("adding a result preserves edits made while the artifact is loading", async () => {
  const pending = Promise.withResolvers<typeof artifact>()
  const append = useBrowserDraft(sessionID).artifact(() => pending.promise)
  parts = [{ type: "text", content: "New draft", start: 0, end: 9 }]
  pending.resolve(artifact)
  await append
  expect(parts).toEqual([
    { type: "text", content: "New draft", start: 0, end: 9 },
    { ...artifact, type: "attachment", id: expect.any(String) },
  ])
  expect(release).toHaveBeenCalledTimes(1)
})

test("text results append after existing text without replacing attachments", async () => {
  const draft = useBrowserDraft(sessionID)
  await draft.text("First")
  parts.push({ ...artifact, type: "attachment", id: "existing" })
  await draft.text("Next")
  expect(parts).toEqual([
    { type: "text", content: "First", start: 0, end: 5 },
    { ...artifact, type: "attachment", id: "existing" },
    { type: "text", content: "\n\nNext", start: 5, end: 11 },
  ])
  expect(release).toHaveBeenCalledTimes(2)
})

test("a local export is uploaded once and added to the draft with its name and annotation", async () => {
  const file = new File(["a,b\n"], "export.csv", { type: "text/csv" })
  await useBrowserDraft(sessionID).attach(file, "Browser export")
  expect(uploads).toEqual([file])
  expect(parts[0]).toEqual({ type: "text", content: "Browser export", start: 0, end: 14 })
  expect(parts[1]).toEqual({
    type: "attachment",
    id: expect.any(String),
    filename: "export.csv",
    mime: "text/csv",
    size: 4,
    url: "asset://browser-export",
  } satisfies UploadedAttachmentPart)
  expect(writes).toHaveLength(1)
  expect(release).toHaveBeenCalledTimes(1)
})
