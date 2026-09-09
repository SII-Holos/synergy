import "../../src/product-registration"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { describe, expect, test } from "bun:test"
import path from "path"
import { createBuiltinInternalAgents } from "@ericsanchezok/synergy-harness/test/internal/agent/builtin-internal"
import { createBuiltinLegacySubagents } from "@ericsanchezok/synergy-harness/test/internal/agent/builtin-legacy-subagents"
import { createBuiltinMaxSubagents } from "@ericsanchezok/synergy-harness/test/internal/agent/builtin-max-subagents"
import { createBuiltinPrimaryAgents } from "@ericsanchezok/synergy-harness/test/internal/agent/builtin-primary"
import { buildSynergyMaxPrompt } from "@ericsanchezok/synergy-harness/test/internal/agent/prompt/synergy-max/builder"
import { buildSynergyPrompt } from "@ericsanchezok/synergy-harness/test/internal/agent/prompt/synergy/builder"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { truncateSkillDescription } from "@ericsanchezok/synergy-runtime-local/tools/skill"

const PROMPT_DIR = path.join(import.meta.dir, "../../../harness/src/agent/prompt")
const TOOL_DIR = path.join(import.meta.dir, "../../../runtime-local/src/tools")

function sourceBytes(relativePath: string): number {
  const bytes = Bun.file(path.join(TOOL_DIR, relativePath)).size
  expect(bytes).toBeGreaterThan(0)
  return bytes
}

function productionAgentInfos() {
  const ctx = {
    defaults: PermissionNext.fromConfig({}),
    user: PermissionNext.fromConfig({}),
    role: () => undefined,
    evolutionActive: true,
  }
  const agents = {
    ...createBuiltinPrimaryAgents(ctx),
    ...createBuiltinLegacySubagents(ctx),
    ...createBuiltinMaxSubagents(ctx),
    ...createBuiltinInternalAgents(ctx),
    ...AgentBuiltins.collect(ctx),
  }
  return Object.values(agents).map((agent) => ({
    name: agent.name,
    description: agent.description ?? "",
    mode: agent.mode,
    hidden: agent.hidden,
    visibleTo: agent.visibleTo,
    delegationGroups: agent.delegationGroups,
  }))
}

describe("static prompt and tool context size budgets", () => {
  test("rendered primary prompts stay within budget with the production agent catalog", () => {
    const infos = productionAgentInfos()
    expect(infos.length).toBeGreaterThanOrEqual(50)
    // Thresholds are measured production values with ~2% headroom. The
    // generated agent table dominates synergy-max's rendered size, and the
    // shared memory section (4,363 chars) is explicitly out of scope.
    expect(buildSynergyPrompt(infos).length).toBeLessThanOrEqual(46_000)
    expect(buildSynergyMaxPrompt(infos).length).toBeLessThanOrEqual(42_500)
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
