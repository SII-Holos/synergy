import { describe, expect, test } from "bun:test"
import path from "path"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "master",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.skill", () => {
  test("builtin skill output does not expose source-only script paths", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()
        const result = await tool.execute({ name: "skill-creator" }, ctx)

        expect(result.title).toBe("Loaded skill: skill-creator")
        expect(result.output).toContain("**Available scripts**:")
        expect(result.output).toContain("built-in helper")
        expect(result.output).toContain("##### Recommended")
        expect(result.output).toContain("##### Also Supported")
        expect(result.output).toContain("##### Compatibility")
        expect(result.output).not.toContain("packages/synergy/src/skill/builtin/skill-creator")
      },
    })
  })

  test("skill tool init degrades gracefully when a skill file has invalid frontmatter", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const brokenSkillDir = path.join(dir, ".synergy", "skill", "broken-skill")
        await Bun.write(
          path.join(brokenSkillDir, "SKILL.md"),
          `---
name: broken-skill
description: bad: yaml: here
---

# Broken Skill
`,
        )
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()
        expect(tool.description).toContain("Load a skill")
        const tools = await ToolRegistry.tools("test-provider")
        expect(tools.some((item) => item.id === "skill")).toBe(true)
      },
    })
  })

  test("external skill output includes source and compatibility details", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".openclaw", "skills", "image-lab")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: image-lab
description: OpenClaw image workflow.
metadata: {"openclaw":{"requires":{"env":["GEMINI_API_KEY"]}}}
command-dispatch: tool
---

# Image Lab
`,
        )
      },
    })

    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SkillTool.init()
          const result = await tool.execute({ name: "image-lab" }, ctx)
          expect(result.output).toContain("**Source**: openclaw")
          expect(result.output).toContain("**Compatibility**: partial")
          expect(result.output).toContain("**Warnings**:")
          expect(result.output).toContain("**Unsupported**:")
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })
})
