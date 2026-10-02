import { expect, test } from "bun:test"
import { createStore, produce } from "solid-js/store"
import { clearConversationContent, type ConversationContentState } from "../../src/context/conversation-content-state"

test("evicted messages lose every derived content bucket and version", () => {
  const [state, setState] = createStore<ConversationContentState>({
    part: {},
    partSummary: {},
    partPage: { old: { hasMore: false }, other: {} },
    partVersion: { one: "v1", other: "v2" },
  })
  setState("partSummary", "old", [
    { id: "one", sessionID: "s", messageID: "old", type: "text", preview: "old", content: { bytes: 3, version: "v1" } },
  ])
  setState(produce((draft) => clearConversationContent(draft, "old")))
  expect(state.partSummary.old).toBeUndefined()
  expect(state.partPage.old).toBeUndefined()
  expect(state.partVersion.one).toBeUndefined()
  expect(state.partPage.other).toEqual({})
  expect(state.partVersion.other).toBe("v2")
})

test("history recovery retains row summaries while invalidating bodies, pages and versions", () => {
  const summary = {
    id: "one",
    sessionID: "s",
    messageID: "old",
    type: "text" as const,
    preview: "old",
    content: { bytes: 3, version: "v1" },
  }
  const [state, setState] = createStore<ConversationContentState>({
    part: { old: [{ id: "one", sessionID: "s", messageID: "old", type: "text", text: "old" }] },
    partSummary: { old: [summary] },
    partPage: { old: { hasMore: false } },
    partVersion: { one: "v1" },
  })
  setState(produce((draft) => clearConversationContent(draft, "old", { preserveSummaries: true })))
  expect(state.partSummary.old).toEqual([summary])
  expect(state.part.old).toBeUndefined()
  expect(state.partPage.old).toBeUndefined()
  expect(state.partVersion.one).toBeUndefined()
})
