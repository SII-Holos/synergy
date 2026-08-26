import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command/command"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"

const SKILL_NAME = "synergy-prompt-architect"

const toolCtx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe.serial("synergy-prompt-architect builtin skill", () => {
  test("is registered as a canonical builtin with a triggering description", async () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name)
    expect(names).toContain(SKILL_NAME)

    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    expect(Skill.Manifest.safeParse({ name: builtin.name, description: builtin.description }).success).toBe(true)
    expect(builtin.builtin).toBe(true)
    expect(builtin.description.toLowerCase()).toContain("system prompt")
    expect(builtin.description.toLowerCase()).toContain("agent")
    expect(builtin.description.toLowerCase()).toContain("role")
    expect(builtin.description.toLowerCase()).toContain("tool")
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

  test("keeps the layered architecture, runtime separation, and capability references in content", async () => {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.name === SKILL_NAME)!
    const content = builtin.content

    expect(content).toContain("Layered architecture")
    expect(content).toContain("Role and mission")
    expect(content).toContain("Prompt vs runtime separation")
    expect(content).toContain("runtime tool spec")
    expect(content).toContain("## Reference files")

    const references = builtin.references ?? {}
    expect(Object.keys(references).sort()).toEqual([
      "references/capability-modules.txt",
      "references/evaluation-checklist.txt",
      "references/prompt-engineering-principles.txt",
    ])
    expect(references["references/prompt-engineering-principles.txt"]).toContain("## Principles")
    expect(references["references/evaluation-checklist.txt"]).toContain("## Evaluation checklist")
    expect(references["references/capability-modules.txt"]).toContain("## Capability modules")
  })

  test("loads body and on-demand references through the skill tool and registers as a slash command", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()

        const body = await tool.execute({ name: SKILL_NAME }, toolCtx)
        expect(body.output).toContain("Layered architecture")
        expect(body.output).toContain("Prompt vs runtime separation")
        expect(body.output).toContain("references/evaluation-checklist.txt")

        for (const [reference, expected] of [
          ["references/evaluation-checklist.txt", "## Evaluation checklist"],
          ["references/prompt-engineering-principles.txt", "## Principles"],
          ["references/capability-modules.txt", "## Capability modules"],
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
