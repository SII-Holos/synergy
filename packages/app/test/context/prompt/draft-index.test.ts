import { beforeEach, describe, expect, test } from "bun:test"
import { Persist } from "../../../src/utils/persist"
import { hasDraftSession, markDraftSession, rebuildDraftSessionIndex } from "../../../src/context/prompt/draft-index"

const DIR_A = "/tmp/workspace-draft-test-a"
const DIR_B = "/tmp/workspace-draft-test-b"

function writeEntry(target: { storage?: string; key: string }, value: string) {
  const localStorageKey = target.storage ? `${target.storage}:${target.key}` : target.key
  localStorage.setItem(localStorageKey, value)
}

function writePromptState(dir: string, session: string | undefined, value: unknown) {
  writeEntry(Persist.scoped(dir, session, "prompt"), JSON.stringify(value))
}

function promptStorageEventKey(dir: string, session: string) {
  return `${Persist.session(dir, session, "prompt").storage}:session:${session}:prompt`
}

const cleanState = { prompt: [{ type: "text", content: "", start: 0, end: 0 }], context: { items: [] } }
const dirtyState = { prompt: [{ type: "text", content: "hello", start: 0, end: 5 }], context: { items: [] } }
const contextOnlyState = {
  prompt: [{ type: "text", content: "", start: 0, end: 0 }],
  context: { items: [{ type: "file", path: "/repo/a.ts" }] },
}

beforeEach(() => {
  localStorage.clear()
  rebuildDraftSessionIndex()
})

describe("draft session index scan", () => {
  test("flags sessions whose stored prompt differs from the default", () => {
    writePromptState(DIR_A, "ses_dirty", dirtyState)
    writePromptState(DIR_A, "ses_clean", cleanState)

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_dirty")).toBe(true)
    expect(hasDraftSession("ses_clean")).toBe(false)
  })

  test("does not flag context-only drafts, matching the composer dirty signal", () => {
    writePromptState(DIR_A, "ses_context_only", contextOnlyState)

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_context_only")).toBe(false)
  })

  test("ignores workspace-level prompts, legacy keys, and non-workspace storage", () => {
    writePromptState(DIR_A, undefined, dirtyState)
    writeEntry({ key: `${DIR_A}/prompt/ses_legacy.v2` }, JSON.stringify(dirtyState))
    writeEntry(Persist.global("prompt-history"), JSON.stringify({ entries: [{ prompt: "hello" }] }))

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_legacy")).toBe(false)
  })

  test("skips entries with unparsable payloads", () => {
    const target = Persist.session(DIR_A, "ses_garbage", "prompt")
    writeEntry(target, "{not json")

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_garbage")).toBe(false)
  })

  test("covers every workspace storage file", () => {
    writePromptState(DIR_A, "ses_in_a", dirtyState)
    writePromptState(DIR_B, "ses_in_b", dirtyState)

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_in_a")).toBe(true)
    expect(hasDraftSession("ses_in_b")).toBe(true)
  })
})

describe("draft session index live marks", () => {
  test("adds and removes a session draft mark", () => {
    markDraftSession("ses_live", true)
    expect(hasDraftSession("ses_live")).toBe(true)

    markDraftSession("ses_live", false)
    expect(hasDraftSession("ses_live")).toBe(false)
  })

  test("ignores marks without a session id and redundant marks", () => {
    markDraftSession(undefined, true)
    expect(hasDraftSession("undefined")).toBe(false)

    markDraftSession("ses_redundant", false)
    markDraftSession("ses_redundant", false)
    expect(hasDraftSession("ses_redundant")).toBe(false)
  })

  test("rebuild replaces live marks with the stored truth", () => {
    markDraftSession("ses_live_only", true)
    writePromptState(DIR_A, "ses_stored", dirtyState)

    rebuildDraftSessionIndex()

    expect(hasDraftSession("ses_live_only")).toBe(false)
    expect(hasDraftSession("ses_stored")).toBe(true)
  })

  test("marks the draft when another tab writes a workspace prompt entry", () => {
    writePromptState(DIR_A, "ses_cross_tab", dirtyState)
    markDraftSession("ses_cross_tab", false)

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: promptStorageEventKey(DIR_A, "ses_cross_tab"),
        newValue: JSON.stringify(dirtyState),
      }),
    )

    expect(hasDraftSession("ses_cross_tab")).toBe(true)
  })

  test("clears the draft mark when another tab clears a workspace prompt entry", () => {
    markDraftSession("ses_cleared", true)

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: promptStorageEventKey(DIR_A, "ses_cleared"),
        newValue: JSON.stringify(cleanState),
      }),
    )

    expect(hasDraftSession("ses_cleared")).toBe(false)
  })

  test("clears the draft mark when another tab removes a workspace prompt entry", () => {
    markDraftSession("ses_removed", true)

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: promptStorageEventKey(DIR_A, "ses_removed"),
        newValue: null,
      }),
    )

    expect(hasDraftSession("ses_removed")).toBe(false)
  })

  test("ignores storage events for unrelated keys", () => {
    writePromptState(DIR_A, "ses_pending", dirtyState)
    markDraftSession("ses_pending", false)

    window.dispatchEvent(new StorageEvent("storage", { key: "synergy.global.dat:layout", newValue: "{}" }))

    expect(hasDraftSession("ses_pending")).toBe(false)
  })
})
