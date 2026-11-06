import { describe, expect, test } from "bun:test"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { describeBuiltinContract } from "./builtin-contract"

describeBuiltinContract({
  skillName: "agent-manage",
  descriptionKeywords: ["agent", "agent_config", "default agent"],
  bodyPhrases: [
    'expand_tools({ groups: ["agent-config"] })',
    "Present a summary and get confirmation",
    "description` is the delegation signal",
    "## Reference files",
  ],
  references: { "references/fields.txt": ["visibleTo", "delegationGroups", "disable"] },
})

describe.serial("agent-manage operational content", () => {
  test("routes writes through the agent_config tool with validation guarantees", () => {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === "agent-manage")!
    expect(builtin.content).toContain("whole agent graph")
    expect(builtin.content).toContain("set_default")
    expect(builtin.content).toContain("describe")
  })

  test("documents the boundary against built-in agent source development", () => {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === "agent-manage")!

    expect(builtin.content).toContain("add-agent")
    expect(builtin.content).toContain("not modify built-in agent source code")
  })
})
