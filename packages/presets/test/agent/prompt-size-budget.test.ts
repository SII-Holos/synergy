import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import "../../src/registration"
import { describe, expect, test } from "bun:test"
import path from "path"
import { buildCodingPrompt } from "@ericsanchezok/synergy-harness/test/internal/agent/prompt/coding/builder"
import { buildGeneralPrompt } from "@ericsanchezok/synergy-harness/test/internal/agent/prompt/general/builder"

const PROMPT_DIR = path.join(import.meta.dir, "../../../harness/src/agent/prompt")
const TOOL_DIR = path.join(import.meta.dir, "../../../local-runtime/src/tools")

function sourceBytes(relativePath: string): number {
  const bytes = Bun.file(path.join(TOOL_DIR, relativePath)).size
  expect(bytes).toBeGreaterThan(0)
  return bytes
}

describe("static prompt and tool context size budgets", () => {
  test("rendered primary prompts stay within budget with their resolved memory instructions", () =>
    runtime.run(() => {
      expect(Buffer.byteLength(buildGeneralPrompt(), "utf8")).toBeLessThanOrEqual(46_000)
      expect(Buffer.byteLength(buildCodingPrompt(), "utf8")).toBeLessThanOrEqual(28_500)
    }))

  test("general base prompt source stays within budget", () =>
    runtime.run(() => {
      expect(Bun.file(path.join(PROMPT_DIR, "general/base.txt")).size).toBeLessThanOrEqual(40_000)
    }))

  test("slimmed tool descriptions stay within budget", () =>
    runtime.run(() => {
      expect(sourceBytes("bash.txt")).toBeLessThanOrEqual(7_012)
      expect(sourceBytes("revise-file.txt")).toBeLessThanOrEqual(5_000)
      expect(sourceBytes("dagwrite.txt")).toBeLessThanOrEqual(3_250)
      expect(sourceBytes("process.txt")).toBeLessThanOrEqual(5_050)
      expect(Bun.file(path.join(PROMPT_DIR, "../../cortex/tools/task.txt")).size).toBeLessThanOrEqual(3_950)
    }))
})

afterRuntimeTests(() => runtime.close())
