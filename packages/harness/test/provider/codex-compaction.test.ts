import { describe, expect, test } from "bun:test"
import {
  applyReplaySplice,
  buildRemoteCompactionBody,
  buildReplacementHistory,
  clearReplayPlan,
  clearReplayPlanForCacheKey,
  extractRemoteCompactionMetadata,
  getReplayPlan,
  isCodexResponseItem,
  modelMessagesToItems,
  parseRemoteCompactionEvents,
  readSseJsonEvents,
  remoteCompactionHeaders,
  setReplayPlan,
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

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

async function readSseEvents(stream: ReadableStream<Uint8Array>, opts?: { maxEventBytes?: number }) {
  const out: unknown[] = []
  for await (const event of readSseJsonEvents(stream, opts)) out.push(event)
  return out
}

describe("codex-compaction readSseJsonEvents", () => {
  const sse = [
    'data: {"type":"response.created"}',
    "",
    'data: {"type":"response.output_item.done","item":{"type":"compaction","id":"c1"}}',
    "",
    "data: [DONE]",
    "",
  ].join("\r\n")

  test("parses data blocks across chunk boundaries, tolerates CRLF and [DONE]", async () => {
    // Split mid-line to exercise the incremental decoder.
    const midpoint = Math.floor(sse.length / 2)
    const events = await readSseEvents(sseStream([sse.slice(0, midpoint), sse.slice(midpoint)]))
    expect(events).toHaveLength(2)
    expect((events[1] as { type: string }).type).toBe("response.output_item.done")
  })

  test("skips malformed JSON blocks", async () => {
    const events = await readSseEvents(sseStream(['data: {not-json}\n\ndata: {"ok":1}\n\n']))
    expect(events).toEqual([{ ok: 1 }])
  })

  test("parses LF and CRLF boundaries interchangeably", async () => {
    const mixed = 'data: {"a":1}\n\ndata: {"b":2}\r\n\r\ndata: {"c":3}\n\n'
    const events = await readSseEvents(sseStream([mixed]))
    expect(events).toHaveLength(3)
  })

  test("throws when a single event exceeds the byte bound and cancels the stream", async () => {
    const stream = sseStream([`data: ${JSON.stringify({ big: "x".repeat(64) })}\n\n`])
    await expect(readSseEvents(stream, { maxEventBytes: 32 })).rejects.toThrow(/exceeded the 32-byte bound/)
  })

  test("interrupts a pending read when the signal aborts", async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"first":1}\n\n'))
        // Never close; the abort must interrupt the second read.
      },
    })
    const reader = readSseJsonEvents(stream, { signal: controller.signal })
    expect(await reader.next()).toEqual({ done: false, value: { first: 1 } })
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(reader.next()).rejects.toThrow(/cancelled/)
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

describe("codex-compaction replay registry", () => {
  const plan = { replacementHistory: [COMPACTION_ITEM], summaryText: "SUMMARY" }

  test("registers, reads, and clears a plan by cache key", () => {
    setReplayPlan("session-a", "cache-a", plan)
    expect(getReplayPlan("cache-a")).toEqual(plan)
    expect(getReplayPlan("missing")).toBeUndefined()
    clearReplayPlan("session-a")
    expect(getReplayPlan("cache-a")).toBeUndefined()
  })

  test("re-registering a session replaces the previous plan", () => {
    setReplayPlan("session-a", "cache-a", plan)
    setReplayPlan("session-a", "cache-b", { replacementHistory: [COMPACTION_ITEM], summaryText: "NEW" })
    expect(getReplayPlan("cache-a")).toBeUndefined()
    expect(getReplayPlan("cache-b")).toBeDefined()
    clearReplayPlan("session-a")
  })

  test("clearing by cache key removes the session mapping", () => {
    setReplayPlan("session-a", "cache-a", plan)
    clearReplayPlanForCacheKey("cache-a")
    expect(getReplayPlan("cache-a")).toBeUndefined()
    // The session mapping is gone too, so a later clear-by-session is a no-op.
    clearReplayPlan("session-a")
    expect(getReplayPlan("cache-a")).toBeUndefined()
  })

  test("registering an undefined plan clears a previous entry", () => {
    setReplayPlan("session-a", "cache-a", plan)
    setReplayPlan("session-a", "cache-a", undefined)
    expect(getReplayPlan("cache-a")).toBeUndefined()
  })
})

describe("codex-compaction modelMessagesToItems image URLs", () => {
  function imagePartsOf(items: CodexResponseItem[]): Array<{ type: string; image_url?: string }> {
    const message = items.find((item) => "role" in item && item.role === "user")
    expect(message).toBeDefined()
    return (message as { content: Array<{ type: string; image_url?: string }> }).content.filter(
      (part) => part.type === "input_image",
    )
  }

  test("does not double-wrap an existing data URL", () => {
    const dataURL = "data:image/png;base64,AAAA"
    const items = modelMessagesToItems([
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: dataURL }] },
    ])
    expect(imagePartsOf(items)[0]!.image_url).toBe(dataURL)
  })

  test("does not wrap an HTTP(S) image URL", () => {
    const httpURL = "https://example.com/image.png"
    const items = modelMessagesToItems([
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: httpURL }] },
    ])
    expect(imagePartsOf(items)[0]!.image_url).toBe(httpURL)
  })

  test("wraps bare base64 payloads with the data-URL prefix", () => {
    const items = modelMessagesToItems([
      { role: "user", content: [{ type: "file", mediaType: "image/jpeg", data: "AAAA" }] },
    ])
    expect(imagePartsOf(items)[0]!.image_url).toBe("data:image/jpeg;base64,AAAA")
  })
})

describe("codex-compaction repeated compaction chaining", () => {
  test("buildReplacementHistory retains prior opaque compaction items", () => {
    const priorCompaction: CodexResponseItem = { type: "compaction", encrypted_content: "first-blob" }
    const newCompaction: CodexResponseItem = { type: "compaction", encrypted_content: "second-blob" }
    const history = buildReplacementHistory([userItem("fresh user turn"), priorCompaction], newCompaction)
    const compactionItems = history.filter(
      (item): item is { type: "compaction"; encrypted_content: string } => "type" in item && item.type === "compaction",
    )
    expect(compactionItems.map((item) => item.encrypted_content)).toEqual(["first-blob", "second-blob"])
    expect(history[history.length - 1]).toEqual(newCompaction)
  })
})

describe("codex-compaction metadata apiModelID", () => {
  test("preserves the resolved API model id when present", () => {
    const meta = extractRemoteCompactionMetadata({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        implementation: "responses_compaction_v2",
        modelKey: "openai-codex/alias",
        providerID: "openai-codex",
        modelID: "alias",
        apiModelID: "gpt-5.4-codex",
        replacementHistory: USER_ITEMS,
      },
    })
    expect(meta).toBeDefined()
    expect(meta!.apiModelID).toBe("gpt-5.4-codex")
  })

  test("omits apiModelID when absent", () => {
    const meta = extractRemoteCompactionMetadata({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        implementation: "responses_compaction_v2",
        modelKey: "openai-codex/gpt-5.4-codex",
        providerID: "openai-codex",
        modelID: "gpt-5.4-codex",
        replacementHistory: USER_ITEMS,
      },
    })
    expect(meta).toBeDefined()
    expect(meta!.apiModelID).toBeUndefined()
  })
})
