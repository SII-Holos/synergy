import { describe, expect, test } from "bun:test"
import path from "path"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"
import { buildSynergyPrompt } from "../../src/agent/prompt/synergy/builder"
import { truncateSkillDescription } from "../../src/tool/skill"

const PROMPT_DIR = path.join(import.meta.dir, "../../src/agent/prompt")
const TOOL_DIR = path.join(import.meta.dir, "../../src/tool")

function sourceBytes(relativePath: string): number {
  return Bun.file(path.join(TOOL_DIR, relativePath)).size
}

describe("static prompt and tool context size budgets", () => {
  test("rendered primary prompts stay within budget", () => {
    // Rendered budgets sit at the documented +10% tolerance because the shared
    // memory section renders at 4,363 chars (planning estimated ~750) and
    // active-memory sizing is explicitly out of scope for this change.
    expect(buildSynergyPrompt([]).length).toBeLessThanOrEqual(44_000)
    expect(buildSynergyMaxPrompt([]).length).toBeLessThanOrEqual(27_500)
  })

  test("synergy base prompt source stays within budget", () => {
    expect(Bun.file(path.join(PROMPT_DIR, "synergy/base.txt")).size).toBeLessThanOrEqual(40_000)
  })

  test("slimmed tool descriptions stay within budget", () => {
    expect(sourceBytes("bash.txt")).toBeLessThanOrEqual(7_000)
    expect(sourceBytes("revise-file.txt")).toBeLessThanOrEqual(5_000)
    expect(sourceBytes("dagwrite.txt")).toBeLessThanOrEqual(6_500)
  })

  test("skill descriptions truncate to a single bounded line", () => {
    const long = "First line with " + "very ".repeat(60) + "long tail\nsecond line detail"
    const truncated = truncateSkillDescription(long)
    expect(truncated.length).toBeLessThanOrEqual(104)
    expect(truncated).not.toContain("\n")
    expect(truncated.endsWith("…")).toBe(true)
    expect(truncateSkillDescription("short description")).toBe("short description")
  })
})
