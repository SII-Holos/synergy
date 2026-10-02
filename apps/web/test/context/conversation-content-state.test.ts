import { expect, test } from "bun:test"
import { createStore, produce } from "solid-js/store"
import { clearConversationContent, type ConversationContentState } from "../../src/context/conversation-content-state"

test("evicted or recovered messages lose every derived content bucket and version", () => {
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
