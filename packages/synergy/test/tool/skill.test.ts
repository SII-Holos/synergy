import { describe, expect, test } from "bun:test"
import path from "path"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool/registry"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe.serial("tool.skill", () => {
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

    await ScopeContext.provide({
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
      await ScopeContext.provide({
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
