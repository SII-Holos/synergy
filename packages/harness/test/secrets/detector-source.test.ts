import { afterEach, expect, test } from "bun:test"
import type { SecretDetection } from "@ericsanchezok/synergy-secret-detection"
import { SecretDetectorSource } from "../../src/secrets/detector-source"
import { SecretMask } from "../../src/secrets/mask"
import { SecretVault } from "../../src/secrets/vault"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const values: string[] = []
afterEach(() =>
  runtime.run(async () => {
    SecretDetectorSource.register(undefined)
    for (const value of values.splice(0)) await SecretVault.remove(SecretVault.idOf(value))
  }),
)

test("a registered detector masks original spans and retains exact known-value protection", () =>
  runtime.run(async () => {
    const value = `custom-${crypto.randomUUID()}`
    values.push(value)
    const detector: SecretDetection.Detector = {
      id: "fixture",
      version: "1",
      async detect({ text, source }) {
        expect(source).toBe("user_message")
        const start = text.indexOf(value)
        return { complete: true, findings: [{ start, end: start + value.length, kind: "custom" }] }
      },
    }
    SecretDetectorSource.register(detector)
    const masked = await SecretMask.maskPart({ type: "text", text: `🔐 ${value} ${value}` })
    const token = SecretMask.token(SecretVault.idOf(value))
    expect(masked.text).toBe(`🔐 ${token} ${token}`)
    SecretDetectorSource.register({
      id: "negative",
      version: "1",
      async detect() {
        return { complete: true, findings: [] }
      },
    })
    const result = await SecretMask.transformResult({ output: `known ${value}` })
    expect(result.output).toBe(`known ${token}`)
  }))

test("incomplete or invalid detector output cannot be persisted as clean text", () =>
  runtime.run(async () => {
    SecretDetectorSource.register({
      id: "partial",
      version: "1",
      async detect() {
        return { complete: false, reason: "input_limit", findings: [] }
      },
    })
    await expect(SecretMask.maskPart({ type: "text", text: "unknown credential" })).rejects.toMatchObject({
      code: "incomplete",
    })
    SecretDetectorSource.register({
      id: "invalid",
      version: "1",
      async detect() {
        return { complete: true, findings: [{ start: 0, end: 1000, kind: "key" }] }
      },
    })
    await expect(SecretMask.transformResult({ output: "short" })).rejects.toMatchObject({ code: "invalid_result" })
  }))

test("batch registration deduplicates values and preserves existing policy and source", () =>
  runtime.run(async () => {
    const first = `batch-${crypto.randomUUID()}`
    const second = `batch-${crypto.randomUUID()}`
    values.push(first, second)
    const entry = await SecretVault.register(first, { kind: "user" }, { policy: { tools: ["bash"] } })
    const index = await SecretVault.registerMany([first, second, second], { kind: "heuristic", context: "tool_output" })
    expect(index.filter((item) => item.value === second)).toHaveLength(1)
    expect(await SecretVault.get(entry.id)).toMatchObject({ source: { kind: "user" }, policy: { tools: ["bash"] } })
    expect(await SecretVault.reveal(SecretVault.idOf(second))).toBe(second)
  }))

test("longer registered values win when a value contains another secret", () =>
  runtime.run(async () => {
    const short = `nested-${crypto.randomUUID()}`
    const long = `${short}-suffix`
    values.push(short, long)
    await SecretVault.register(short, { kind: "user" })
    await SecretVault.register(long, { kind: "user" })
    expect(await SecretMask.apply(long)).toBe(SecretMask.token(SecretVault.idOf(long)))
  }))

test("an adapter cannot report a value the host length policy would leave unmasked", () =>
  runtime.run(async () => {
    SecretDetectorSource.register({
      id: "short",
      version: "1",
      async detect() {
        return { complete: true, findings: [{ start: 0, end: 3, kind: "key" }] }
      },
    })
    await expect(
      SecretMask.captureAndApply("abc", { kind: "heuristic", context: "user_message" }),
    ).rejects.toMatchObject({ code: "invalid_result" })
  }))

afterRuntimeTests(() => runtime.close())
