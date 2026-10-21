import { expect, test } from "bun:test"
import { confirmsReply, terminalText, temporalEvidence, type HistoricalInput, type ReplayCase } from "../script/history"
import { pairedInterval, summarize } from "../script/evaluate"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"

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
  expect(summarize(results, 101)).toMatchObject({ expectedCases: 101, finished: false, qualityResolved: false })
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
    sessionID: "past",
    family: "past",
    at: 1,
    text: "先检查 API 边界",
    revision: 1,
    input: artifact,
    preceding: { reply: "API 实现完成", at: 0 },
  }
  const item = {
    family: "target",
    cutoff: 5,
    reference: "继续实现",
    current: [{ role: "assistant", content: "API 通过测试" }],
  } as ReplayCase
  const result = temporalEvidence(item, [
    source,
    { ...source, id: "future", at: 6 },
    { ...source, id: "copy", family: "target" },
    { ...source, id: "answer", text: "继续实现！" },
  ])
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
