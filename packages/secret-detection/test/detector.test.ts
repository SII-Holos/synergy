import { describe, expect, test } from "bun:test"
import { RegexDetector, SecretDetection } from "../src/index"

const input = { text: "🔐 key: ghp_fakekey12345678", source: "user_message" as const }

describe("detector contract", () => {
  test("locates complete original values with UTF-16 offsets", async () => {
    const result = await SecretDetection.detect(RegexDetector, input)
    expect(result.complete).toBe(true)
    expect(result.findings).toHaveLength(1)
    const match = result.findings[0]!
    expect(match.start).toBe(8)
    expect(input.text.slice(match.start, match.end)).toBe("ghp_fakekey12345678")
  })

  test("retains distinct occurrences and merges overlapping prefix matches", async () => {
    const text = "sk-key_abcdefgh ghp_abcdefgh ghp_abcdefgh"
    const result = await SecretDetection.detect(RegexDetector, { ...input, text })
    expect(result.findings.map((f) => text.slice(f.start, f.end))).toEqual([
      "sk-key_abcdefgh",
      "ghp_abcdefgh",
      "ghp_abcdefgh",
    ])
  })

  test("preserves baseline limitations without claiming generic secret detection", async () => {
    for (const text of [
      "password=plain-example-password",
      "Authorization: Bearer plain-example-token",
      "x".repeat(64),
    ]) {
      expect(await SecretDetection.detect(RegexDetector, { ...input, text })).toEqual({ findings: [], complete: true })
    }
  })

  test("accepts an asynchronous alternate detector", async () => {
    const detector: SecretDetection.Detector = {
      id: "fixture",
      version: "1",
      async detect({ text, source }) {
        expect(source).toBe("user_message")
        return { findings: [{ start: 0, end: text.length, kind: "fixture", score: 0.8 }], complete: true }
      },
    }
    expect((await SecretDetection.detect(detector, input)).findings[0]?.score).toBe(0.8)
  })

  test.each(
    [
      [{ start: -1, end: 4, kind: "key" }],
      [{ start: 1, end: 1, kind: "key" }],
      [{ start: 0, end: 1000, kind: "key" }],
      [
        { start: 0, end: 4, kind: "key" },
        { start: 3, end: 5, kind: "key" },
      ],
      [
        { start: 8, end: 10, kind: "key" },
        { start: 3, end: 5, kind: "key" },
      ],
      [{ start: 1, end: 4, kind: "key" }],
    ].map((findings) => ({ findings })),
  )("rejects invalid, overlapping and split-surrogate spans: %j", async ({ findings }) => {
    const detector: SecretDetection.Detector = {
      id: "bad-spans",
      version: "1",
      async detect() {
        return { findings, complete: true }
      },
    }
    await expect(SecretDetection.detect(detector, input)).rejects.toMatchObject({ code: "invalid_result" })
  })

  test("incomplete output remains distinct from a clean scan", async () => {
    const detector: SecretDetection.Detector = {
      id: "partial",
      version: "1",
      async detect() {
        return { findings: [], complete: false, reason: "input_limit" }
      },
    }
    expect(await SecretDetection.detect(detector, input)).toEqual({
      findings: [],
      complete: false,
      reason: "input_limit",
    })
  })

  test("sanitizes detector failures", async () => {
    const detector: SecretDetection.Detector = {
      id: "failure",
      version: "1",
      async detect() {
        throw new Error(input.text)
      },
    }
    await expect(SecretDetection.detect(detector, input)).rejects.toMatchObject({
      code: "detector_failed",
      message: "Secret detection failed: detector_failed",
    })
  })

  test("cancels in-flight adapters and rejects already aborted calls", async () => {
    const controller = new AbortController()
    let adapterSignal: AbortSignal | undefined
    const detector: SecretDetection.Detector = {
      id: "pending",
      version: "1",
      async detect({ signal }) {
        adapterSignal = signal
        controller.abort()
        return new Promise(() => {})
      },
    }
    await expect(SecretDetection.detect(detector, { ...input, signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    })
    expect(adapterSignal?.aborted).toBe(true)
    await expect(SecretDetection.detect(RegexDetector, { ...input, signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    })
  })

  test("times out a stalled adapter and forwards cancellation", async () => {
    let adapterSignal: AbortSignal | undefined
    const detector: SecretDetection.Detector = {
      id: "stalled",
      version: "1",
      async detect({ signal }) {
        adapterSignal = signal
        return new Promise(() => {})
      },
    }
    await expect(SecretDetection.detect(detector, input, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" })
    expect(adapterSignal?.aborted).toBe(true)
  })
})
