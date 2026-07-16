import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import {
  ClarusProjectActivitySchema,
  MAX_FILE_REFS,
  MAX_FILE_REF_RECURSION_DEPTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_RECURSION_DEPTH,
  MAX_PAYLOAD_AGGREGATE_BYTES,
  MAX_PAYLOAD_STRING_LENGTH,
} from "../../src/clarus/schemas"
import { ClarusRestClient } from "../../src/clarus/rest-client"

// ── Helpers ───────────────────────────────────────────────────

function validActivity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentId: "agent_test",
    projectId: "proj_test",
    messageId: "msg_test",
    receivedAt: Date.now(),
    ...overrides,
  }
}

function standardEnvelope(data: unknown, code = 0) {
  return { code, message: "ok", data }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeCredential(agentId = "agent_test", agentSecret = "secret_test") {
  return { agentId, agentSecret }
}

function fakeFetch(responseFactory: () => Response | Promise<Response>) {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return responseFactory()
  }
}

function wireMessageItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    message_id: "msg_1",
    message_type: "text",
    content: "Hello",
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function wireMessageList(items: unknown[], nextCursor: string | null = null) {
  return {
    items,
    ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
  }
}

function makeClient(fetchOverride?: () => Response | Promise<Response>) {
  return new ClarusRestClient({
    apiUrl: "https://localhost:8443",
    credentials: async () => makeCredential(),
    fetch: fakeFetch(fetchOverride ?? (() => jsonResponse(standardEnvelope(wireMessageList([]))))),
  })
}

// ── Schema Validation Tests ───────────────────────────────────

describe("ClarusProjectActivitySchema payload bounds", () => {
  // ── Valid baseline ──────────────────────────────────────

  test("accepts valid activity without fileRefs or metadata", () => {
    const result = ClarusProjectActivitySchema.parse(validActivity())
    expect(result.agentId).toBe("agent_test")
  })

  test("accepts valid activity with ordinary fileRefs", () => {
    const result = ClarusProjectActivitySchema.parse(
      validActivity({ fileRefs: [{ name: "report.pdf", url: "https://example.com/report.pdf" }] }),
    )
    expect(result.fileRefs).toHaveLength(1)
  })

  test("accepts valid activity with ordinary metadata", () => {
    const result = ClarusProjectActivitySchema.parse(
      validActivity({ metadata: { source: "web", priority: 1, tags: ["urgent", "review"] } }),
    )
    expect(result.metadata).toEqual({ source: "web", priority: 1, tags: ["urgent", "review"] })
  })

  test("accepts valid mixed nested JSON within bounds", () => {
    const result = ClarusProjectActivitySchema.parse(
      validActivity({
        fileRefs: [
          { name: "doc.pdf", meta: { pages: 10, version: 2 } },
          { name: "image.png", meta: { width: 800, height: 600 } },
        ],
        metadata: {
          key1: "value",
          key2: { nested: true, arr: [1, 2, 3] },
          key3: { deeper: { leaf: "ok" } },
        },
      }),
    )
    expect(result.fileRefs).toHaveLength(2)
    expect(result.metadata?.key3).toEqual({ deeper: { leaf: "ok" } })
  })

  test("accepts bounded dispatched task metadata", () => {
    const metadata = {
      event_type: "runtime.task.dispatched",
      assigned_agent_id: "agent_test",
      payload: {
        project_id: "proj_test",
        context: { session: { state: { ready: true } } },
        input_refs: [[[[[["bounded"]]]]]],
      },
    }
    const result = ClarusProjectActivitySchema.parse(validActivity({ metadata }))
    expect(result.metadata).toEqual(metadata)
  })

  test("accepts bounded nested fileRefs from the live API", () => {
    const fileRefs = [[[[[[[["bounded"]]]]]]]]
    const result = ClarusProjectActivitySchema.parse(validActivity({ fileRefs }))

    expect(result.fileRefs).toEqual(fileRefs)
  })

  // ── FileRefs bounds ─────────────────────────────────────

  test("rejects fileRefs exceeding max item count", () => {
    const refs = Array.from({ length: MAX_FILE_REFS + 1 }, (_, i) => ({ name: `f${i}` }))
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: refs }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/<=50|too_big|items/i)
  })

  test("rejects fileRefs with deep nesting exceeding max depth", () => {
    let deep: unknown = { leaf: "value" }
    for (let i = 0; i < MAX_FILE_REF_RECURSION_DEPTH + 2; i++) {
      deep = [deep]
    }
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: deep }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("recursion")
  })

  test("rejects fileRefs with cycle", () => {
    const a: Record<string, unknown> = { name: "a" }
    const b: Record<string, unknown> = { name: "b", ref: a }
    a.ref = b
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: [a] }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("cycle")
  })

  test("rejects fileRefs exceeding aggregate byte budget via many small strings", () => {
    // Many entries with 1.5 KB strings each to hit the 64 KB budget
    const big = Array.from({ length: 45 }, (_, i) => ({
      name: `file_${i}`,
      description: "x".repeat(1500),
    }))
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: big }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/aggregate|string/)
  })

  test("rejects fileRefs with excessively long string value", () => {
    const refs = [{ name: "x".repeat(MAX_PAYLOAD_STRING_LENGTH + 1) }]
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: refs }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("string")
  })

  test("rejects fileRefs with excessively long object key", () => {
    const refs = [{ ["x".repeat(MAX_METADATA_KEY_LENGTH + 1)]: "v" }]
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: refs }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("key")
  })

  test("rejects fileRefs with too many object keys", () => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < MAX_METADATA_KEYS + 1; i++) obj[`k${i}`] = `v${i}`
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: [obj] }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("key")
  })

  test("rejects fileRefs with nested array exceeding item limit", () => {
    const arr = Array.from({ length: 51 }, (_, i) => ({ n: i }))
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: [arr] }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("array")
  })

  // ── Metadata bounds ─────────────────────────────────────

  test("rejects metadata exceeding max key count", () => {
    const oversize: Record<string, unknown> = {}
    for (let i = 0; i < MAX_METADATA_KEYS + 1; i++) oversize[`k${i}`] = `v${i}`
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: oversize }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("key count")
  })

  test("rejects metadata exceeding max key length", () => {
    const result = ClarusProjectActivitySchema.safeParse(
      validActivity({ metadata: { ["x".repeat(MAX_METADATA_KEY_LENGTH + 1)]: "v" } }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/key|Invalid/i)
  })

  test("rejects metadata with deep nesting exceeding max depth", () => {
    let deep: Record<string, unknown> = { leaf: "value" }
    for (let i = 0; i < MAX_METADATA_RECURSION_DEPTH + 2; i++) {
      deep = { nested: deep }
    }
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: deep }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("recursion")
  })

  test("rejects metadata with cycle", () => {
    const a: Record<string, unknown> = { name: "a" }
    const b: Record<string, unknown> = { name: "b", ref: a }
    a.ref = b
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: a }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("cycle")
  })

  test("rejects metadata exceeding aggregate byte budget via many small strings", () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 45; i++) {
      big[`key_${i}`] = "x".repeat(1500)
    }
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: big }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/aggregate|string/)
  })

  test("accepts the bounded live metadata string length", () => {
    const metadata = { value: "x".repeat(5395) }
    const result = ClarusProjectActivitySchema.parse(validActivity({ metadata }))
    expect(result.metadata).toEqual(metadata)
  })

  test("rejects metadata strings above the bounded live contract", () => {
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: { value: "x".repeat(8193) } }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("string")
  })

  test("rejects metadata with nested array exceeding item limit", () => {
    const result = ClarusProjectActivitySchema.safeParse(
      validActivity({ metadata: { arr: Array.from({ length: 51 }, (_, i) => i) } }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("array")
  })

  // ── Redacted diagnostics ────────────────────────────────

  test("error messages do not include full rejected payload", () => {
    const big = "x".repeat(10000)
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ fileRefs: [{ data: big }] }))
    expect(result.success).toBe(false)
    const message = result.error!.issues[0]!.message
    expect(message).not.toContain("x".repeat(10000))
    expect(message.length).toBeLessThan(200)
  })

  test("error messages do not include full payload on key-count violation", () => {
    const oversize: Record<string, unknown> = {}
    for (let i = 0; i < MAX_METADATA_KEYS + 1; i++) oversize[`key_${i}`] = "value"
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: oversize }))
    expect(result.success).toBe(false)
    const message = result.error!.issues[0]!.message
    // Short diagnostic, not the full keys
    expect(message.length).toBeLessThan(200)
  })

  // ── Multibyte Unicode ───────────────────────────────────

  test("handles multibyte Unicode within bounds", () => {
    const result = ClarusProjectActivitySchema.safeParse(
      validActivity({
        metadata: {
          chinese: "中文测试",
          emoji: "🎉🚀",
          mixed: "hello 世界 🌍",
        },
      }),
    )
    expect(result.success).toBe(true)
  })

  test("rejects multibyte strings that exceed the aggregate UTF-8 byte budget", () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) {
      big[`k${i}`] = "中".repeat(2500)
    }
    const result = ClarusProjectActivitySchema.safeParse(validActivity({ metadata: big }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("aggregate")
  })
})

// ── REST Client Tests ──────────────────────────────────────────

describe("ClarusRestClient payload bounds (wire path)", () => {
  test("accepts the bounded live metadata string length through client", async () => {
    const metadata = { val: "x".repeat(5395) }
    const client = makeClient(() => jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata })]))))

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0]?.metadata).toEqual(metadata)
  })

  test("rejects metadata strings above the bounded live contract through client", async () => {
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: { val: "x".repeat(8193) } })]))),
    )

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata string exceeds its length limit",
    )
  })

  test("passes valid metadata with arrays and nested objects through client", async () => {
    const valid = {
      tags: ["a", "b", "c"],
      config: { debug: true, threshold: 0.5 },
      extra: null,
    }

    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: valid })]))),
    )

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0].metadata).toEqual(valid)
  })

  test("passes valid fileRefs through client", async () => {
    const refs = [
      { name: "file1.pdf", size: 1024 },
      { name: "file2.png", size: 2048 },
    ]

    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ file_refs: refs })]))),
    )

    const result = await client.listMessages({ projectId: "proj_1" })
    expect(result.messages[0].fileRefs).toEqual(refs)
  })

  test("rejects metadata array item count exceeding limit through client", async () => {
    const client = makeClient(() =>
      jsonResponse(
        standardEnvelope(
          wireMessageList([wireMessageItem({ metadata: { arr: Array.from({ length: 51 }, (_, i) => i) } })]),
        ),
      ),
    )

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata array exceeds its item limit",
    )
  })

  test("error does not expose raw payload values through client", async () => {
    const bigVal = "x".repeat(MAX_PAYLOAD_STRING_LENGTH + 1)
    const client = makeClient(() =>
      jsonResponse(standardEnvelope(wireMessageList([wireMessageItem({ metadata: { secret: bigVal } })]))),
    )

    await expect(client.listMessages({ projectId: "proj_1" })).rejects.toThrow(
      "Clarus metadata string exceeds its length limit",
    )
    await expect(client.listMessages({ projectId: "proj_1" })).rejects.not.toThrow(bigVal)
  })
})

// ── Bound Table Verification ───────────────────────────────────

describe("payload bound constants", () => {
  test("MAX_FILE_REFS is 50", () => expect(MAX_FILE_REFS).toBe(50))
  test("MAX_FILE_REF_RECURSION_DEPTH is 8", () => expect(MAX_FILE_REF_RECURSION_DEPTH).toBe(8))
  test("MAX_METADATA_KEYS is 50", () => expect(MAX_METADATA_KEYS).toBe(50))
  test("MAX_METADATA_KEY_LENGTH is 128", () => expect(MAX_METADATA_KEY_LENGTH).toBe(128))
  test("MAX_METADATA_RECURSION_DEPTH is 8", () => expect(MAX_METADATA_RECURSION_DEPTH).toBe(8))
  test("MAX_PAYLOAD_STRING_LENGTH is 8192", () => expect(MAX_PAYLOAD_STRING_LENGTH).toBe(8192))
  test("MAX_PAYLOAD_AGGREGATE_BYTES is 65536", () => expect(MAX_PAYLOAD_AGGREGATE_BYTES).toBe(65536))
})
