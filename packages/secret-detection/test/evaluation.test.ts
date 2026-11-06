import { expect, test } from "bun:test"
import { SecretEvaluation } from "../src/evaluation"
import { RegexDetector, SecretDetection } from "../src/index"

test("scores full-span protection separately from exact location and false positives", async () => {
  const cases: SecretEvaluation.Case[] = [
    { id: "covered", group: "fixture", text: "a SECRET z", source: "tool_output", expected: [{ start: 2, end: 8 }] },
    { id: "partial", group: "fixture", text: "SECRET", source: "user_message", expected: [{ start: 0, end: 6 }] },
    { id: "clean", group: "fixture", text: "clean", source: "user_message", expected: [] },
  ]
  const detector: SecretDetection.Detector = {
    id: "fixture",
    version: "1",
    async detect({ text }) {
      return { complete: true, findings: [{ start: 0, end: text === "SECRET" ? 3 : text.length, kind: "key" }] }
    },
  }
  const report = await SecretEvaluation.evaluate(detector, cases)
  expect(report.metrics).toMatchObject({
    expected: 2,
    predicted: 3,
    exactMatches: 0,
    fullyCovered: 1,
    falsePositives: 1,
    cleanCases: 1,
    falsePositiveCases: 1,
  })
  expect(report.metrics.fullCoverageRecall).toBe(0.5)
  expect(report.metrics.cleanMessageFalsePositiveRate).toBe(1)
  expect(JSON.stringify(report)).not.toContain("SECRET")
})

test("incomplete and failed scans remain in the report and recall denominator", async () => {
  const cases: SecretEvaluation.Case[] = [
    { id: "partial", group: "fixture", text: "key", source: "user_message", expected: [{ start: 0, end: 3 }] },
    { id: "failed", group: "fixture", text: "secret", source: "tool_output", expected: [{ start: 0, end: 6 }] },
  ]
  const detector: SecretDetection.Detector = {
    id: "fixture",
    version: "1",
    async detect({ text }) {
      if (text === "secret") throw new Error(text)
      return { complete: false, reason: "input_limit", findings: [] }
    },
  }
  const report = await SecretEvaluation.evaluate(detector, cases)
  expect(report.metrics).toMatchObject({ expected: 2, failures: 1, incomplete: 1, fullCoverageRecall: 0 })
  expect(report.cases.map((row) => row.status)).toEqual(["incomplete", "failed"])
})

test("evaluation never passes gold labels to the detector or counts failures as clean negatives", async () => {
  const detector: SecretDetection.Detector = {
    id: "fixture",
    version: "1",
    async detect(input) {
      expect(Object.keys(input).sort()).toEqual(["signal", "source", "text"])
      throw new Error("unavailable")
    },
  }
  const report = await SecretEvaluation.evaluate(detector, [
    { id: "negative", group: "fixture", text: "text", source: "user_message", expected: [] },
  ])
  expect(report.metrics.completedCleanCases).toBe(0)
  expect(report.metrics.cleanMessageFalsePositiveRate).toBeNull()
})

test("loads independent positive, negative and known-gap labels", async () => {
  const dataset = SecretEvaluation.Dataset.parse(
    await Bun.file(new URL("../fixtures/corpus.json", import.meta.url)).json(),
  )
  const report = await SecretEvaluation.evaluate(RegexDetector, dataset.cases)
  expect(report.metrics.expected).toBeGreaterThan(10)
  expect(report.metrics.cleanCases).toBeGreaterThan(5)
  expect(report.metrics.fullCoverageRecall).toBeLessThan(1)
  expect(report.metrics.failures).toBe(0)
})

test("benchmark records first-call and warm latency without timing assertions", async () => {
  const report = await SecretEvaluation.benchmark(
    RegexDetector,
    { text: "ordinary prose", source: "tool_output" },
    { samples: 3, warmup: 1 },
  )
  expect(report.samples).toBe(3)
  expect(report.p95Ms).toBeGreaterThanOrEqual(report.p50Ms!)
  await expect(
    SecretEvaluation.benchmark(RegexDetector, { text: "", source: "tool_output" }, { samples: 0, warmup: 1 }),
  ).rejects.toBeInstanceOf(RangeError)
})

test("rejects duplicate cases and invalid gold offsets before evaluation", async () => {
  const sample: SecretEvaluation.Case = {
    id: "duplicate",
    group: "fixture",
    text: "text",
    source: "tool_output",
    expected: [],
  }
  await expect(SecretEvaluation.evaluate(RegexDetector, [sample, sample])).rejects.toThrow("Duplicate")
  await expect(
    SecretEvaluation.evaluate(RegexDetector, [{ ...sample, expected: [{ start: 0, end: 9 }] }]),
  ).rejects.toMatchObject({ code: "invalid_result" })
})
