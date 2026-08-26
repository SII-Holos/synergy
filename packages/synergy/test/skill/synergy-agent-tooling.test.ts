import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command/command"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"

const SKILL_NAME = "synergy-agent-tooling"

const toolCtx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe.serial("synergy-agent-tooling builtin skill", () => {
  test("is registered as a canonical builtin with a triggering description", async () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name)
    expect(names).toContain(SKILL_NAME)

    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    expect(Skill.Manifest.safeParse({ name: builtin.name, description: builtin.description }).success).toBe(true)
    expect(builtin.builtin).toBe(true)
    expect(builtin.description.toLowerCase()).toContain("tool")
    expect(builtin.description.toLowerCase()).toContain("mcp")
    expect(builtin.description.toLowerCase()).toContain("cli")
  })

  test("loads through the runtime catalog as a memory-backed builtin", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get(SKILL_NAME)
        expect(skill).toBeDefined()
        expect(skill!.origin).toEqual({ kind: "builtin" })
        expect(skill!.backing.kind).toBe("memory")
        expect(skill!.diagnostics).toEqual([])
      },
    })
  })

  test("keeps the tool contract, consolidation, and workflow references in content", async () => {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    const content = builtin.content

    expect(content).toContain("Tool contract")
    expect(content).toContain("consolidation")
    expect(content).toContain("## Reference files")

    const references = builtin.references ?? {}
    expect(Object.keys(references).sort()).toEqual([
      "references/cli-creator.txt",
      "references/mcp-builder.txt",
      "references/tool-design.txt",
    ])
    expect(references["references/tool-design.txt"]).toContain("## Audit checklist")
    expect(references["references/mcp-builder.txt"]).toContain("## Workflow")
    expect(references["references/cli-creator.txt"]).toContain("## Command contract")
  })

  test("loads body and on-demand references through the skill tool and registers as a slash command", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()

        const body = await tool.execute({ name: SKILL_NAME }, toolCtx)
        expect(body.output).toContain("Tool contract")
        expect(body.output).toContain("consolidation")
        expect(body.output).toContain("references/tool-design.txt")

        for (const [reference, expected] of [
          ["references/tool-design.txt", "## Audit checklist"],
          ["references/mcp-builder.txt", "## Workflow"],
          ["references/cli-creator.txt", "## Command contract"],
        ]) {
          const loaded = await tool.execute({ name: SKILL_NAME, reference }, toolCtx)
          expect(loaded.output).toContain(expected)
        }

        await Command.reload()
        const command = await Command.get(SKILL_NAME)
        expect(command).toBeDefined()
        expect(command).toMatchObject({ source: "skill" })
      },
    })
  })
})
