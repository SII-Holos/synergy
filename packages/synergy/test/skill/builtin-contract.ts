import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command/command"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"

const toolCtx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

export function describeBuiltinContract(input: {
  skillName: string
  descriptionKeywords: string[]
  bodyPhrases: string[]
  references: Record<string, string[]>
  slashCommand?: boolean
}) {
  const { skillName, descriptionKeywords, bodyPhrases, references, slashCommand = false } = input
  const referenceEntries = Object.entries(references)

  describe.serial(`${skillName} builtin skill`, () => {
    test("is registered as a canonical builtin with a triggering description", () => {
      const names = BUILTIN_SKILLS.map((skill) => skill.name)
      expect(names).toContain(skillName)

      const builtin = BUILTIN_SKILLS.find((skill) => skill.name === skillName)!
      expect(Skill.Manifest.safeParse({ name: builtin.name, description: builtin.description }).success).toBe(true)
      expect(builtin.builtin).toBe(true)
      const description = builtin.description.toLowerCase()
      for (const keyword of descriptionKeywords) expect(description).toContain(keyword)
    })

    test("loads through the runtime catalog as a memory-backed builtin", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const skill = await Skill.get(skillName)
          expect(skill).toBeDefined()
          expect(skill!.origin).toEqual({ kind: "builtin" })
          expect(skill!.backing.kind).toBe("memory")
          expect(skill!.diagnostics).toEqual([])
        },
      })
    })

    test("keeps the documented body phrases and on-demand references in content", () => {
      const builtin = BUILTIN_SKILLS.find((skill) => skill.name === skillName)!
      for (const phrase of bodyPhrases) expect(builtin.content).toContain(phrase)
      expect(Object.keys(builtin.references ?? {}).sort()).toEqual(referenceEntries.map(([key]) => key).sort())
      for (const [key, expected] of referenceEntries) {
        for (const phrase of expected) expect(builtin.references?.[key]).toContain(phrase)
      }
    })

    if (slashCommand) {
      test("loads body and on-demand references through the skill tool and registers as a slash command", async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const tool = await SkillTool.init()

            const body = await tool.execute({ name: skillName }, toolCtx)
            for (const phrase of bodyPhrases) expect(body.output).toContain(phrase)

            for (const [reference, expected] of referenceEntries) {
              const loaded = await tool.execute({ name: skillName, reference }, toolCtx)
              for (const phrase of expected) expect(loaded.output).toContain(phrase)
            }

            await Command.reload()
            const command = await Command.get(skillName)
            expect(command).toBeDefined()
            expect(command).toMatchObject({ source: "skill" })
          },
        })
      })
    }
  })
}
