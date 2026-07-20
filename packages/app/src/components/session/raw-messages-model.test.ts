import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import {
  compactSessionMessagesForCopy,
  isRawMessageHistoryComplete,
  loadRawMessages,
  nextRawMessagesLimit,
  rawMessageCreatedAt,
  rawMessageFlags,
  rawMessageIDSegments,
  rawMessageJson,
  rawMessagePreview,
  reconcileRawMessageState,
  selectAllRawMessages,
  sortRawSessionMessages,
  summarizeRawMessageSelection,
  toggleRawMessageSelection,
} from "./raw-messages-model"

const presentation = {
  roles: { user: "Localized user", assistant: "Localized assistant" },
  hiddenFlag: "Localized hidden",
  excludedFlag: "Localized excluded",
}

function user(id: string, created: number, input: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID: "ses_raw",
    role: "user",
    isRoot: true,
    time: { created },
    agent: "synergy",
    model: { providerID: "provider", modelID: "model" },
    ...input,
  }
}

function assistant(id: string, created: number): AssistantMessage {
  return {
    id,
    sessionID: "ses_raw",
    role: "assistant",
    time: { created, completed: created + 1 },
    parentID: "msg_root",
    modelID: "model",
    providerID: "provider",
    mode: "agent",
    agent: "synergy",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("raw message loading", () => {
  test("requests normalized raw history without mutating the effective timeline", async () => {
    const requests: unknown[] = []
    const late = { info: assistant("msg_b", 20), parts: [] }
    const early = { info: user("msg_a", 10), parts: [] }

    const loaded = await loadRawMessages({
      sessionID: "ses_raw",
      limit: 100,
      fetch: async (request) => {
        requests.push(request)
        return { data: [late, early] }
      },
    })

    expect(requests).toEqual([{ sessionID: "ses_raw", raw: true, limit: 100 }])
    expect(loaded.map((entry) => entry.info.id)).toEqual(["msg_a", "msg_b"])
  })
})

describe("raw message presentation", () => {
  test("previews metadata and emits the message-plus-parts JSON shape", () => {
    const raw = {
      info: user("msg_001", 10, { visible: false, includeInContext: false, origin: { type: "agenda" } }),
      parts: [],
    }

    expect(rawMessagePreview(raw, presentation)).toBe("Localized user")
    expect(rawMessageIDSegments(raw)).toEqual({ leading: "msg_001", trailing: "" })
    expect(rawMessageFlags(raw, presentation)).toEqual(["Localized hidden", "Localized excluded"])
    expect(rawMessageCreatedAt(raw)).toBe(10)
    expect(rawMessageFlags({ info: user("msg_visible", 11), parts: [] }, presentation)).toEqual([])
    expect(rawMessageIDSegments({ info: user("msg_00000000000000000000000001", 12), parts: [] })).toEqual({
      leading: "msg_000000000000000000",
      trailing: "00000001",
    })
    expect(Object.keys(JSON.parse(rawMessageJson(raw)))).toEqual(["message", "parts"])
  })

  test("sorts and copies selected records in canonical order without mutating input", () => {
    const late = { info: assistant("msg_z", 20), parts: [] }
    const tiedB = { info: user("msg_b", 10), parts: [] }
    const tiedA = { info: user("msg_a", 10), parts: [] }
    const input = [late, tiedB, tiedA]

    expect(sortRawSessionMessages(input).map((entry) => entry.info.id)).toEqual(["msg_a", "msg_b", "msg_z"])
    expect(input.map((entry) => entry.info.id)).toEqual(["msg_z", "msg_b", "msg_a"])

    const records = JSON.parse(compactSessionMessagesForCopy(input, new Set(["msg_z", "msg_a"]))) as Array<{
      message: { id: string }
      parts: unknown[]
    }>
    expect(records.map((entry) => entry.message.id)).toEqual(["msg_a", "msg_z"])
    expect(Object.keys(records[0])).toEqual(["message", "parts"])
  })
})

describe("raw message selection", () => {
  test("toggles one record without mutating the current selection", () => {
    const current = new Set(["msg_a"])
    const added = toggleRawMessageSelection(current, "msg_b")
    const removed = toggleRawMessageSelection(added, "msg_a")

    expect([...current]).toEqual(["msg_a"])
    expect([...added]).toEqual(["msg_a", "msg_b"])
    expect([...removed]).toEqual(["msg_b"])
  })

  test("selects all currently loaded records", () => {
    const selected = selectAllRawMessages([
      { info: user("msg_a", 10), parts: [] },
      { info: assistant("msg_b", 20), parts: [] },
    ])
    expect([...selected]).toEqual(["msg_a", "msg_b"])
  })

  test("summarizes only loaded selected records", () => {
    const messages = [
      { info: user("msg_a", 10), parts: [] },
      { info: assistant("msg_b", 20), parts: [] },
    ]

    expect(summarizeRawMessageSelection(messages, new Set(["msg_a", "msg_stale"]))).toEqual({
      ids: new Set(["msg_a"]),
      count: 1,
      all: false,
      partial: true,
    })
    expect(summarizeRawMessageSelection(messages, new Set(["msg_a", "msg_b"]))).toMatchObject({
      count: 2,
      all: true,
      partial: false,
    })
  })

  test("reconciles selection and preview against the refreshed window", () => {
    const state = reconcileRawMessageState({
      messages: [
        { info: user("msg_b", 20), parts: [] },
        { info: assistant("msg_c", 30), parts: [] },
      ],
      selectedIds: new Set(["msg_a", "msg_b"]),
      previewId: "msg_a",
    })

    expect([...state.selectedIds]).toEqual(["msg_b"])
    expect(state.previewId).toBeUndefined()
  })
})

describe("raw message incremental history", () => {
  test("continues when a full or root-expanded window grows", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 0,
        previousLoaded: 0,
        previousComplete: false,
        requestedLimit: 100,
        loaded: 103,
      }),
    ).toBe(false)
    expect(nextRawMessagesLimit(100)).toBe(200)
  })

  test("stops when the response is shorter than the requested limit", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 0,
        previousLoaded: 0,
        previousComplete: false,
        requestedLimit: 100,
        loaded: 42,
      }),
    ).toBe(true)
  })

  test("stops when a larger request returns no additional records", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 100,
        previousLoaded: 103,
        previousComplete: false,
        requestedLimit: 200,
        loaded: 103,
      }),
    ).toBe(true)
  })

  test("preserves completion across same-limit refreshes", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 100,
        previousLoaded: 42,
        previousComplete: true,
        requestedLimit: 100,
        loaded: 42,
      }),
    ).toBe(true)
  })

  test("reopens pagination when a completed window refills on refresh", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 100,
        previousLoaded: 42,
        previousComplete: true,
        requestedLimit: 100,
        loaded: 100,
      }),
    ).toBe(false)
  })

  test("preserves completion for a stable root-expanded window", () => {
    expect(
      isRawMessageHistoryComplete({
        previousLimit: 200,
        previousLoaded: 250,
        previousComplete: true,
        requestedLimit: 200,
        loaded: 250,
      }),
    ).toBe(true)
  })
})
