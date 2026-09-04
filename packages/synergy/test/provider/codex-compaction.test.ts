import { describe, expect, test } from "bun:test"
import {
  applyReplaySplice,
  buildRemoteCompactionBody,
  buildReplacementHistory,
  extractRemoteCompactionMetadata,
  isCodexResponseItem,
  parseRemoteCompactionEvents,
  parseSseData,
  remoteCompactionHeaders,
  type CodexResponseItem,
} from "../../src/provider/codex-compaction"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Role-based message items mirror the wire format the SDK serializes for
// Responses `input` (see probe of @ai-sdk/openai serialization).
const USER_ITEMS: CodexResponseItem[] = [
  {
    role: "user",
    content: [{ type: "input_text", text: "first user message with enough text to count" }],
  },
  {
    role: "user",
    content: [{ type: "input_text", text: "second user message" }],
  },
]

const COMPACTION_ITEM: CodexResponseItem = { type: "compaction", encrypted_content: "encrypted-blob" }

function devItem(text: string): CodexResponseItem {
  return { role: "developer", content: text }
}
function assistantItem(text: string): CodexResponseItem {
  return { role: "assistant", content: [{ type: "output_text", text }] }
}
function userItem(text: string): CodexResponseItem {
  return { role: "user", content: [{ type: "input_text", text }] }
}

describe("codex-compaction parseSseData", () => {
  test("parses data blocks, tolerates CRLF and [DONE]", () => {
    const sse = [
      'data: {"type":"response.created"}',
      "",
      'data: {"type":"response.output_item.done","item":{"type":"compaction","id":"c1"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\r\n")
    const events = parseSseData(sse)
    expect(events).toHaveLength(2)
  })

  test("skips malformed JSON blocks", () => {
    expect(parseSseData('data: {not-json}\n\ndata: {"ok":1}')).toHaveLength(1)
  })
})

describe("codex-compaction parseRemoteCompactionEvents", () => {
  const events = (items: unknown[], completed = true) => [
    { type: "response.created" },
    ...items.map((item) => ({ type: "response.output_item.done", item })),
    ...(completed ? [{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } }] : []),
  ]

  test("returns exactly one compaction item and usage", () => {
    const result = parseRemoteCompactionEvents(events([{ type: "compaction", encrypted_content: "blob" }]))
    expect(result.compactionItem.type).toBe("compaction")
    if (result.compactionItem.type === "compaction") {
      expect(result.compactionItem.encrypted_content).toBe("blob")
    }
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 2 })
  })

  test("throws when the stream has no compaction item", () => {
    expect(() => parseRemoteCompactionEvents(events([]))).toThrow(/exactly one compaction item/)
  })

  test("throws when more than one compaction item is present", () => {
    expect(() =>
      parseRemoteCompactionEvents(
        events([
          { type: "compaction", encrypted_content: "a" },
          { type: "compaction", encrypted_content: "b" },
        ]),
      ),
    ).toThrow(/exactly one compaction item, got 2/)
  })

  test("throws when response.failed is received", () => {
    expect(() =>
      parseRemoteCompactionEvents([{ type: "response.failed", response: { error: { message: "upstream boom" } } }]),
    ).toThrow(/upstream boom/)
  })

  test("throws on transport error events", () => {
    expect(() => parseRemoteCompactionEvents([{ type: "error", message: "network" }])).toThrow(/network/)
  })

  test("throws when the stream never completes", () => {
    expect(() =>
      parseRemoteCompactionEvents(events([{ type: "compaction", encrypted_content: "blob" }], false)),
    ).toThrow(/before response.completed/)
  })
})

describe("codex-compaction buildReplacementHistory", () => {
  test("keeps most recent real user messages before the compaction item", () => {
    const history = buildReplacementHistory([...USER_ITEMS, COMPACTION_ITEM], COMPACTION_ITEM)
    expect(history[history.length - 1]).toEqual(COMPACTION_ITEM)
    const userTexts = history
      .filter((item) => "role" in item && item.role === "user")
      .map((item) => ("role" in item && Array.isArray(item.content) ? item.content[0] : undefined))
    expect(userTexts.length).toBeGreaterThan(0)
  })

  test("throws when the returned item is not a compaction item", () => {
    expect(() => buildReplacementHistory([...USER_ITEMS, COMPACTION_ITEM], { role: "assistant", content: [] })).toThrow(
      /did not return a compaction item/,
    )
  })

  test("clones the compaction item instead of aliasing it", () => {
    const history = buildReplacementHistory([...USER_ITEMS, COMPACTION_ITEM], COMPACTION_ITEM)
    expect(history[history.length - 1]).not.toBe(COMPACTION_ITEM)
    expect(history[history.length - 1]).toEqual(COMPACTION_ITEM)
  })
})

describe("codex-compaction applyReplaySplice", () => {
  const history = buildReplacementHistory([...USER_ITEMS, COMPACTION_ITEM], COMPACTION_ITEM)
  const plan = { replacementHistory: history, summaryText: "SUMMARY TEXT HERE" }

  const normalBody = {
    model: "gpt-5.3-codex",
    input: [
      devItem("system prompt"),
      userItem("root task"),
      assistantItem("SUMMARY TEXT HERE"),
      userItem("continue working"),
    ],
  }

  test("splices replacement history over the compacted region", () => {
    const spliced = applyReplaySplice(normalBody, plan)
    expect(spliced).toBeDefined()
    const input = spliced!.input as CodexResponseItem[]
    // developer prefix preserved
    expect(input[0]).toEqual(devItem("system prompt"))
    // replacement history present
    const replacementTexts = input.slice(1, 1 + history.length)
    expect(replacementTexts).toEqual(history)
    // trailing messages after the summary preserved
    expect(input[input.length - 1]).toEqual(userItem("continue working"))
    // summary text no longer present
    const allText = JSON.stringify(input)
    expect(allText).not.toContain("SUMMARY TEXT HERE")
  })

  test("returns undefined when the body is itself a compaction request", () => {
    const compactionBody = {
      model: "gpt-5.3-codex",
      input: [...normalBody.input, { type: "compaction_trigger" } as CodexResponseItem],
    }
    expect(applyReplaySplice(compactionBody, plan)).toBeUndefined()
  })

  test("returns undefined when the summary text cannot be located", () => {
    expect(applyReplaySplice(normalBody, { ...plan, summaryText: "DOES NOT EXIST" })).toBeUndefined()
  })

  test("returns undefined when a non-user item sits between prefix and summary", () => {
    const gapBody = {
      input: [devItem("sys"), assistantItem("plain"), assistantItem("SUMMARY TEXT HERE"), userItem("tail")],
    }
    expect(applyReplaySplice(gapBody, plan)).toBeUndefined()
  })

  test("returns undefined when input is not an array", () => {
    expect(applyReplaySplice({ input: "nope" }, plan)).toBeUndefined()
  })

  test("returns undefined when replacement history lacks a trailing compaction item", () => {
    expect(
      applyReplaySplice(normalBody, { replacementHistory: [userItem("only")], summaryText: "SUMMARY TEXT HERE" }),
    ).toBeUndefined()
  })

  test("handles a summary split across multiple assistant items whose joined text equals the stored summary", () => {
    const multiPartBody = {
      input: [
        devItem("sys"),
        userItem("root"),
        assistantItem("SUMMARY PART ONE "),
        assistantItem("SUMMARY PART TWO"),
        userItem("tail"),
      ],
    }
    const spliced = applyReplaySplice(multiPartBody, {
      ...plan,
      summaryText: "SUMMARY PART ONE SUMMARY PART TWO",
    })
    expect(spliced).toBeDefined()
    const input = spliced!.input as CodexResponseItem[]
    expect(input[input.length - 1]).toEqual(userItem("tail"))
    // Neither summary fragment remains; replacement history occupies the middle.
    expect(JSON.stringify(input)).not.toContain("SUMMARY PART")
    expect(input[1]).toEqual(history[0])
  })

  test("falls back when a consecutive assistant run does not equal the summary", () => {
    const body = {
      input: [
        devItem("sys"),
        userItem("root"),
        assistantItem("SUMMARY TEXT HERE"),
        assistantItem("EXTRA TEXT"),
        userItem("tail"),
      ],
    }
    // Joined text ("SUMMARY TEXT HEREEXTRA TEXT") != stored summary → no splice.
    expect(applyReplaySplice(body, plan)).toBeUndefined()
  })

  test("tolerates whitespace drift between the stored summary and serialized text", () => {
    const body = {
      input: [devItem("sys"), userItem("root"), assistantItem("SUMMARY\t TEXT  HERE\n"), userItem("tail")],
    }
    expect(applyReplaySplice(body, plan)).toBeDefined()
  })
})

describe("codex-compaction metadata", () => {
  test("extracts v2 metadata from a message metadata record", () => {
    const meta = extractRemoteCompactionMetadata({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        implementation: "responses_compaction_v2",
        modelKey: "openai-codex/gpt-5.3-codex",
        providerID: "openai-codex",
        modelID: "gpt-5.3-codex",
        replacementHistory: USER_ITEMS,
        usage: { input: 1 },
      },
    })
    expect(meta).toBeDefined()
    expect(meta!.providerID).toBe("openai-codex")
    expect(meta!.modelID).toBe("gpt-5.3-codex")
    expect(meta!.replacementHistory).toHaveLength(USER_ITEMS.length)
  })

  test("rejects non-v2 or non-compaction records", () => {
    expect(extractRemoteCompactionMetadata({ remoteCompaction: { version: 1, provider: "old" } })).toBeUndefined()
    expect(
      extractRemoteCompactionMetadata({
        remoteCompaction: { version: 2, provider: "openai-responses-compaction", replacementHistory: [] },
      }),
    ).toBeUndefined()
    expect(extractRemoteCompactionMetadata(undefined)).toBeUndefined()
  })

  test("filters malformed items out of replacementHistory", () => {
    const meta = extractRemoteCompactionMetadata({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        modelKey: "k",
        providerID: "openai-codex",
        modelID: "m",
        replacementHistory: [USER_ITEMS[0], { type: "garbage" }],
      },
    })
    expect(meta).toBeDefined()
    expect(meta!.replacementHistory).toHaveLength(1)
  })
})

describe("codex-compaction request construction", () => {
  test("remoteCompactionHeaders sets the private protocol headers", () => {
    const headers = remoteCompactionHeaders({
      accessToken: "tok",
      accountID: "acct_1",
      originator: "codex_cli_rs",
    })
    expect(headers.authorization).toBe("Bearer tok")
    expect(headers["x-codex-beta-features"]).toContain("remote_compaction_v2")
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental")
    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1")
    expect(headers.accept).toBe("text/event-stream")
  })

  test("remoteCompactionHeaders omits account id when absent", () => {
    const headers = remoteCompactionHeaders({ accessToken: "tok" })
    expect(headers["ChatGPT-Account-ID"]).toBeUndefined()
  })

  test("buildRemoteCompactionBody appends the trigger and keeps store false", () => {
    const body = buildRemoteCompactionBody({ modelID: "gpt-5.3-codex", items: USER_ITEMS, sessionID: "s1" })
    const input = body.input as CodexResponseItem[]
    expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.prompt_cache_key).toBe("s1")
  })
})

describe("codex-compaction type guard", () => {
  test("isCodexResponseItem validates known shapes", () => {
    expect(isCodexResponseItem({ type: "compaction", encrypted_content: "x" })).toBe(true)
    expect(isCodexResponseItem({ type: "compaction_trigger" })).toBe(true)
    expect(isCodexResponseItem({ type: "function_call", name: "a", arguments: "{}", call_id: "c" })).toBe(true)
    expect(isCodexResponseItem({ role: "user", content: [] })).toBe(true)
    expect(isCodexResponseItem({ role: "developer", content: "sys" })).toBe(true)
    // Wire format has no `type: "message"` tag on message items.
    expect(isCodexResponseItem({ type: "message", role: "user", content: [] })).toBe(false)
    expect(isCodexResponseItem({ role: "admin", content: [] })).toBe(false)
    expect(isCodexResponseItem({ type: "nonsense" })).toBe(false)
    expect(isCodexResponseItem(null)).toBe(false)
    expect(isCodexResponseItem("str")).toBe(false)
  })
})
