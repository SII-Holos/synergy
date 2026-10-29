import { expect, test } from "bun:test"
import { Info } from "../../src/config/schema"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("accepts compaction thresholds from 20% through the full window", () =>
  runtime.run(() => {
    for (const overflowThreshold of [0.2, 0.3, 0.95, 1])
      expect(Info.safeParse({ compaction: { overflowThreshold } }).success).toBe(true)
    for (const overflowThreshold of [0.19, 1.01])
      expect(Info.safeParse({ compaction: { overflowThreshold } }).success).toBe(false)
  }))

afterRuntimeTests(() => runtime.close())
