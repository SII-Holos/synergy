import { expect, test } from "bun:test"
import {
  confirmsReply,
  requestCatalog,
  terminalText,
  sealHistory,
  temporalEvidence,
  type HistoricalInput,
  type ReplayCase,
} from "../script/history"
import { pairedInterval, summarize } from "../script/evaluate"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"

test("frozen eligibility applies final credential discoveries without reconnecting removed turns", async () => {
  const runtime = await testRuntime()
  try {
    await runtime.run(async () => {
      const credential = `fixture-${crypto.randomUUID()}`
      const history = ["开始", credential, "检查 API", "完成"].map(
        (text, index) => ({ id: String(index), text }) as HistoricalInput,
      )
      const cases = history.slice(1).map(
        (target, index) =>
          ({
            id: target.id,
            current: [
              {
                role: "assistant",
                content: index === 2 ? `http://localhost:1455/auth/callback?code=${credential}` : "完成",
              },
            ],
            reference: target.text,
            sources: { previous: history[index], target },
          }) as ReplayCase,
      )
      history[2]!.preceding = { identity: "reply", reply: "上一轮", at: 1 }
      history[3]!.preceding = { identity: "protected-reply", reply: credential, at: 2 }
      const sealed = await sealHistory({ history, cases, catalog: [] })
      expect(sealed.history.map((item) => item.id)).toEqual(["0", "2", "3"])
      expect(sealed.cases.map((item) => item.id)).toEqual(["3"])
      expect(sealed.history.find((item) => item.id === "2")?.preceding).toBeUndefined()
      expect(sealed.maskRevision).toMatch(/^[a-f\d]{64}$/)
      expect(history[2]!.preceding?.reply).toBe("上一轮")
      expect(sealed.history.find((item) => item.id === "3")?.preceding?.reply).toBe(credential)
    })
  } finally {
    await runtime.close()
  }
})

test("immutable response reconstruction uses real text deltas and refuses tool or failed endings", () => {
  const text = [
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", text: "已完成" },
    { type: "text-delta", id: "a", text: " API" },
    { type: "finish-step", finishReason: "stop" },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n")
  expect(terminalText(text)).toBe("已完成 API")
  expect(terminalText(text + '\n{"type":"abort"}')).toBeUndefined()
  expect(terminalText(text.replace('"stop"', '"tool-calls"'))).toBeUndefined()
})

test("retrieval catalog accepts attributed text and rejects reasoning, invalid ranges and conflicting versions", () => {
  const owner = { scopeID: "scope", sessionID: "session" }
  const text = {
    category: "assistantMessages" as const,
    precision: "source" as const,
    path: ["messages", "0"],
    selector: ["content", "0", "text"],
    messageID: "reply",
    partID: "part",
    source: "assistant",
    characters: 3,
  }
  const request = {
    messages: [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "API" },
          { type: "reasoning" as const, text: "private" },
        ],
      },
    ],
    contextSources: [text, { ...text, selector: ["content", "1", "text"], partID: "reasoning", characters: 7 }],
  }
  expect(requestCatalog(request, owner, 4)).toEqual([
    {
      identity: "scope/session/reply",
      sessionID: "session",
      messageID: "reply",
      available: 4,
      role: "assistant",
      parts: ["API"],
    },
  ])
  expect(
    requestCatalog({ ...request, contextSources: [{ ...text, range: { start: 0, end: 9 } }] }, owner, 4),
  ).toMatchObject([{ parts: null }])
  expect(
    requestCatalog(
      { ...request, contextSources: [text, { ...text, range: { start: 0, end: 1 }, characters: 1 }] },
      owner,
      4,
    ),
  ).toMatchObject([{ parts: null }])
})

test("incomplete observations fence earlier catalog versions until a complete observation restores them", () => {
  const owner = { scopeID: "scope", sessionID: "past" }
  const source = {
    category: "userMessages" as const,
    precision: "source" as const,
    path: ["messages", "0"],
    selector: ["content", "0", "text"],
    messageID: "message",
    partID: "first",
    source: "user",
    characters: 3,
  }
  const request = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "API" },
          { type: "text" as const, text: "boundary" },
        ],
      },
    ],
    contextSources: [source, { ...source, selector: ["content", "1", "text"], partID: "second", characters: 8 }],
  }
  const good = requestCatalog(request, owner, 1)
  const incomplete = requestCatalog(
    { ...request, contextSources: [source, { ...request.contextSources[1]!, characters: 99 }] },
    owner,
    2,
  )
  expect(incomplete).toMatchObject([{ parts: null }])
  const partial = requestCatalog(
    {
      ...request,
      contextSources: [source, { ...request.contextSources[1]!, range: { start: 0, end: 3 }, characters: 3 }],
    },
    owner,
    2,
  )
  expect(partial).toMatchObject([{ parts: null }])
  const history = [
    {
      id: "past",
      identity: "scope/past/message",
      sessionID: "past",
      family: "past",
      at: 1,
      text: "API\n\nboundary",
    } as HistoricalInput,
  ]
  const item = {
    sessionID: "target",
    family: "target",
    current: [{ role: "assistant", content: "API" }],
    reference: "测试",
  } as ReplayCase
  const catalog = [...good, ...incomplete, ...requestCatalog(request, owner, 3)]
  expect(temporalEvidence({ ...item, cutoff: 2 }, history, catalog).available).toBe(1)
  expect(temporalEvidence({ ...item, cutoff: 3 }, history, catalog).available).toBe(0)
  expect(temporalEvidence({ ...item, cutoff: 4 }, history, catalog).available).toBe(1)
})

test("replay requires the terminal reply to survive into the next immutable request unchanged", () => {
  const messages = [
    { role: "assistant" as const, content: "API 已完成" },
    { role: "user" as const, content: "检查异常路径" },
  ]
  const input = {
    message: { id: "root" } as MessageV2.Info,
    parts: [{ id: "part", type: "text" as const, messageID: "root", sessionID: "session", text: "检查异常路径" }],
  }
  const source = {
    category: "userMessages" as const,
    precision: "source" as const,
    path: ["messages", "1"],
    selector: ["content"],
    messageID: "root",
    partID: "part",
    source: "user",
    characters: 6,
  }
  const request = { messages, contextSources: [source] }
  expect(confirmsReply(request, input, "API 已完成")).toBe(true)
  expect(confirmsReply(request, input, "经过显示钩子修改的回复")).toBe(false)
  expect(confirmsReply({ messages }, input, "API 已完成")).toBe(false)
  expect(
    confirmsReply({ ...request, contextSources: [{ ...source, messageID: "old-root" }] }, input, "API 已完成"),
  ).toBe(false)
  expect(confirmsReply({ ...request, contextSources: [source, source] }, input, "API 已完成")).toBe(false)
  expect(
    confirmsReply(
      {
        ...request,
        messages: [
          ...messages,
          { role: "assistant", content: "另一个任务" },
          { role: "user", content: "检查异常路径" },
        ],
        contextSources: [{ ...source, path: ["messages", "3"] }],
      },
      input,
      "API 已完成",
    ),
  ).toBe(false)
})

test("a successful evaluation prefix cannot satisfy the complete experiment gate", () => {
  const results: Parameters<typeof summarize>[0] = Array.from({ length: 100 }, (_, index) => ({
    fingerprint: String(index),
    item: { family: String(index) } as ReplayCase,
    availableEvidence: 1,
    complete: true,
    predictions: [{ recipe: "full", state: "complete", candidate: "继续实现" }],
    labels: { A: "context", B: "voice", C: "full" },
    eligibility: { predictable: true, category: "short-acceptance", reason: "same target" },
    judgment: {
      scores: ["A", "B", "C"].map((label) => ({
        label: label as "A" | "B" | "C",
        content: 5,
        voice: 5,
        integrityFailures: [],
        reason: "same intent",
      })),
      comparisons: [{ a: "A", b: "C", winner: "b", reason: "same target and author voice" }],
    },
  }))
  expect(summarize(results, 100).qualityResolved).toBe(true)
  expect(summarize(results, 100, false)).toMatchObject({
    qualityResolved: false,
    evidenceError: "protected_content_index_changed",
  })
  expect(summarize(results, 101)).toMatchObject({ expectedCases: 101, finished: false, qualityResolved: false })
})

test("ablation reporting separates ambiguous candidates, failures and provider latency", () => {
  const result: Parameters<typeof summarize>[0][number] = {
    fingerprint: "case",
    item: { family: "family" } as ReplayCase,
    availableEvidence: 0,
    complete: true,
    labels: { A: "context", B: "voice", C: "full" },
    eligibility: { predictable: false, category: "ambiguous-new-task", reason: "new topic" },
    predictions: [
      { recipe: "context", state: "complete", candidate: "凭空编一个任务" },
      { recipe: "voice", state: "complete", candidate: null },
      {
        recipe: "full",
        state: "failed",
        candidate: null,
        error: "provider unavailable",
        receipt: { wallMs: 2, calls: [], attempts: [] },
      },
    ],
  }
  const summary = summarize([result], 1)
  expect(summary.recipes.context).toMatchObject({ ambiguous: 1, ambiguousEmitted: 1, emitted: 1 })
  expect(summary.recipes.voice).toMatchObject({ ambiguous: 1, ambiguousEmitted: 0, emitted: 0 })
  expect(summary.recipes.full).toMatchObject({ failed: 1, emitted: 0 })
  expect(summary.latency.full).toMatchObject({ successful: { count: 0 }, failed: { count: 1 } })
})

test("temporal conditioning excludes future, held-out duplicates and the target source family", () => {
  const artifact = {
    version: 1 as const,
    id: "ref",
    mediaType: "application/json",
    bytes: 1,
    chunks: 1,
    sha256: "a".repeat(64),
    status: "complete" as const,
  }
  const source: HistoricalInput = {
    id: "past",
    identity: "scope/past/message",
    sessionID: "past",
    family: "past",
    at: 1,
    text: "先检查 API 边界",
    revision: 1,
    input: artifact,
    preceding: { identity: "scope/past/previous", reply: "API 实现完成", at: 0 },
  }
  const item = {
    family: "target",
    cutoff: 5,
    reference: "继续实现",
    current: [{ role: "assistant", content: "API 通过测试" }],
  } as ReplayCase
  const result = temporalEvidence(
    item,
    [
      source,
      { ...source, id: "future", at: 6 },
      { ...source, id: "copy", family: "target" },
      { ...source, id: "answer", text: "继续实现！" },
    ],
    [
      {
        identity: source.identity,
        sessionID: source.sessionID,
        messageID: "message",
        available: 1,
        role: "user",
        parts: [source.text],
      },
      {
        identity: source.preceding!.identity,
        sessionID: source.sessionID,
        messageID: "previous",
        available: 0,
        role: "assistant",
        parts: [source.preceding!.reply],
      },
    ],
  )
  expect(result.available).toBe(1)
  expect(result.evidence.map((example) => example.id)).toEqual(["past/pair", "past"])
  expect(result.statistics[0]?.count).toBe(1)
  expect(
    pairedInterval([
      { family: "a", win: 1 },
      { family: "b", win: 1 },
    ])[0],
  ).toBeLessThan(0.5)
  expect(pairedInterval([{ family: "a", win: 1 }])).toEqual([0, 1])
})

test("raw retrieval budgets include current-family and contaminated matches before eligibility filtering", () => {
  const item = {
    family: "target",
    sessionID: "target",
    cutoff: 100,
    reference: "继续实现",
    current: [{ role: "assistant", content: "api boundary ownership" }],
  } as ReplayCase
  const source = {
    id: "past",
    identity: "past/message",
    sessionID: "past",
    family: "past",
    at: 1,
    text: "api boundary",
    preceding: { identity: "past/previous", reply: "api boundary ownership", at: 0 },
  } as HistoricalInput
  const catalog = Array.from({ length: 96 }, (_, index) => ({
    identity: `target/message-${index}`,
    sessionID: "target",
    messageID: `message-${index}`,
    available: 2,
    parts: ["api boundary ownership"],
    role: "user" as const,
  }))
  const ranked = temporalEvidence(
    item,
    [source],
    [
      ...catalog,
      {
        identity: source.identity,
        sessionID: "past",
        messageID: "message",
        available: 1,
        role: "user",
        parts: [source.text],
      },
      {
        identity: "past/previous",
        sessionID: "past",
        messageID: "previous",
        available: 1,
        parts: [source.preceding!.reply],
        role: "assistant",
      },
    ],
  )
  expect(ranked.queryCandidates).toEqual([])
})
