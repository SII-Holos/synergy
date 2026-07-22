import { describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Plugin } from "../../src/plugin"
import { Skill } from "../../src/skill"
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

  test("loads project skill references from references directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skill", "reference-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: reference-skill
description: Project skill with references.
---

# Reference Skill

Read references/guide.md.
`,
        )
        await Bun.write(path.join(skillDir, "references", "guide.md"), "# Guide\n\nProject reference body.\n")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()
        const skillResult = await tool.execute({ name: "reference-skill" }, ctx)
        expect(skillResult.output).toContain("references/guide.md")

        const referenceResult = await tool.execute({ name: "reference-skill", reference: "references/guide.md" }, ctx)
        expect(referenceResult.output).toBe("# Guide\n\nProject reference body.")
      },
    })
  })

  test("rejects file-backed reference paths that escape the canonical skill directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skill", "contained-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: contained-skill
description: Project skill with contained references.
---

# Contained Skill
`,
        )
        await Bun.write(path.join(dir, "outside.md"), "outside secret\n")
        await fs.mkdir(path.join(skillDir, "references"), { recursive: true })
        await fs.symlink(path.join(dir, "outside.md"), path.join(skillDir, "references", "escape.md"))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SkillTool.init()
        await expect(tool.execute({ name: "contained-skill", reference: "references/escape.md" }, ctx)).rejects.toThrow(
          'Reference "references/escape.md" not found in skill "contained-skill".',
        )
      },
    })
  })

  test("loads directory-backed plugin skill references on demand", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginDir = path.join(tmp.path, "plugin")
    const skillDir = path.join(pluginDir, "skills", "plugin-reference")
    const markdownSkillDir = path.join(pluginDir, "skills", "plugin-markdown")
    const inlineSkillDir = path.join(pluginDir, "skills", "plugin-inline")
    const inlineFileSkillDir = path.join(pluginDir, "skills", "plugin-inline-file")
    await Bun.write(path.join(skillDir, "content.txt"), "# Plugin Reference\n")
    await Bun.write(path.join(skillDir, "references", "guide.md"), "# Plugin Guide\n")
    await Bun.write(
      path.join(markdownSkillDir, "content.md"),
      "---\ntitle: ignored plugin metadata\n---\n\n# Plugin Markdown\n",
    )
    await Bun.write(path.join(inlineSkillDir, "references", "disk.md"), "# Disk Guide\n")
    await Bun.write(path.join(inlineFileSkillDir, "content.txt"), "# File Must Not Override Inline\n")

    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-reference",
        description: "Directory-backed plugin skill.",
        dir: "skills/plugin-reference",
        contributionId: "plugin-reference",
        pluginId: "plugin-one",
        pluginDir,
      },
      {
        name: "plugin-markdown",
        description: "Directory-backed plugin Markdown skill.",
        dir: "skills/plugin-markdown",
        contributionId: "plugin-markdown",
        pluginId: "plugin-one",
        pluginDir,
      },
      {
        name: "plugin-inline",
        description: "Plugin skill with inline content and directory references.",
        content: "# Inline Plugin",
        references: { "references/memory.md": "# Memory Guide\n" },
        dir: "skills/plugin-inline",
        contributionId: "plugin-inline",
        pluginId: "plugin-one",
        pluginDir,
      },
      {
        name: "plugin-inline-file",
        description: "Inline plugin content takes precedence over directory content.",
        content: "# Inline Wins",
        dir: "skills/plugin-inline-file",
        contributionId: "plugin-inline-file",
        pluginId: "plugin-one",
        pluginDir,
      },
    ])

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const skill = await Skill.get("plugin-reference")
          expect(skill).toMatchObject({
            origin: { kind: "plugin", pluginID: "plugin-one", contributionID: "plugin-reference" },
            backing: { kind: "file", baseDir: skillDir, entryFile: path.join(skillDir, "content.txt") },
          })

          const tool = await SkillTool.init()
          const content = await tool.execute({ name: "plugin-reference" }, ctx)
          expect(content.output).toContain("# Plugin Reference")
          expect(content.output).toContain("references/guide.md")

          const reference = await tool.execute({ name: "plugin-reference", reference: "references/guide.md" }, ctx)
          expect(reference.output).toBe("# Plugin Guide")

          const markdown = await Skill.get("plugin-markdown")
          expect(markdown).toMatchObject({
            backing: { kind: "file", baseDir: markdownSkillDir, entryFile: path.join(markdownSkillDir, "content.md") },
          })
          await expect(tool.execute({ name: "plugin-markdown" }, ctx)).resolves.toMatchObject({
            output: expect.stringContaining("# Plugin Markdown"),
          })

          const inline = await Skill.get("plugin-inline")
          expect(inline).toMatchObject({
            origin: { kind: "plugin", pluginID: "plugin-one", contributionID: "plugin-inline" },
            backing: {
              kind: "memory",
              content: "# Inline Plugin",
              references: {
                "references/memory.md": "# Memory Guide\n",
                "references/disk.md": "# Disk Guide\n",
              },
            },
          })
          const inlineContent = await tool.execute({ name: "plugin-inline" }, ctx)
          expect(inlineContent.output).toContain("# Inline Plugin")
          expect(inlineContent.output).toContain("references/memory.md")
          expect(inlineContent.output).toContain("references/disk.md")
          await expect(
            tool.execute({ name: "plugin-inline", reference: "references/disk.md" }, ctx),
          ).resolves.toMatchObject({ output: "# Disk Guide" })

          const inlineFile = await Skill.get("plugin-inline-file")
          expect(inlineFile).toMatchObject({ backing: { kind: "memory", content: "# Inline Wins" } })
          const inlineFileContent = await tool.execute({ name: "plugin-inline-file" }, ctx)
          expect(inlineFileContent.output).toContain("# Inline Wins")
          expect(inlineFileContent.output).not.toContain("# File Must Not Override Inline")

          await fs.unlink(path.join(skillDir, "content.txt"))
          await expect(Skill.content(skill!)).resolves.toBe("")
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
    }
  })

  test("loads lenient Claude, Codex, and OpenClaw skills through the Skill tool", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "project")
    const fixtures = [
      {
        name: "claude-tool-live",
        source: "claude",
        directory: path.join(project, ".claude", "skills", "claude-tool-live"),
        entry: "Skill.md",
        field: "claude-only: true",
      },
      {
        name: "codex-tool-live",
        source: "codex",
        directory: path.join(project, ".codex", "skills", "codex-tool-live"),
        entry: "Skill.md",
        field: "codex-only: true",
      },
      {
        name: "openclaw-tool-live",
        source: "openclaw",
        directory: path.join(tmp.path, ".openclaw", "skills", "openclaw-tool-live"),
        entry: "SKILL.md",
        field: "command-dispatch: tool",
      },
    ] as const
    await Promise.all(
      fixtures.map((fixture) =>
        Bun.write(
          path.join(fixture.directory, fixture.entry),
          `---\nname: ${fixture.name}\ndescription: ${fixture.source} tool fixture.\n${fixture.field}\n---\n\n# ${fixture.name}\n`,
        ),
      ),
    )

    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const tool = await SkillTool.init()
          for (const fixture of fixtures) {
            const result = await tool.execute({ name: fixture.name }, ctx)
            expect(result.output).toContain(`**Source**: ${fixture.source}`)
            expect(result.output).toContain("**Compatibility**: partial")
            expect(result.output).toContain("**Warnings**:")
            expect(result.output).toContain("**Unsupported**:")
            expect(result.output).toContain(`# ${fixture.name}`)
          }
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })
})
