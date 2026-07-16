import { describe, test, expect, mock } from "bun:test"
import { Skill } from "../../src/skill"
import { SkillPaths } from "../../src/skill/paths"
import { Plugin } from "../../src/plugin"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

const BUILTIN_SKILL_COUNT = BUILTIN_SKILLS.filter((s) => !s.condition).length

function normalizedLocation(location: string) {
  return location.replace(/\\/g, "/")
}

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

async function createSkill(baseDir: string, relativeDir: string, content: string, filename = "SKILL.md") {
  const skillDir = path.join(baseDir, relativeDir)
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(path.join(skillDir, filename), content)
}

// Skill discovery tests share global state (process.env, ScopedState)
// and must run serially to avoid interference between concurrent tests.
describe.serial("skill discovery", () => {
  test("runtime skill root candidates include external compatibility roots without requiring directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      const roots = SkillPaths.runtimeSkillRootCandidatesSync(tmp.path).map(normalizedLocation)

      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".synergy", "skill")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".synergy", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".synergy", "config", "skill")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".synergy", "config", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".claude", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".codex", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".agents", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".openclaw", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, "skills")))
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("runtime skill roots include only existing external compatibility roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await fs.mkdir(path.join(tmp.path, ".codex", "skills"), { recursive: true })
      await fs.mkdir(path.join(tmp.path, ".agents", "skills"), { recursive: true })

      const roots = SkillPaths.runtimeSkillRootsSync(tmp.path).map(normalizedLocation)

      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".codex", "skills")))
      expect(roots).toContain(normalizedLocation(path.join(tmp.path, ".agents", "skills")))
      expect(roots).not.toContain(normalizedLocation(path.join(tmp.path, ".claude", "skills")))
      expect(roots).not.toContain(normalizedLocation(path.join(tmp.path, ".openclaw", "skills")))
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("runtimeSkillRootsSync delegates to runtimeSkillRootCandidatesSync", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      const candidates = SkillPaths.runtimeSkillRootCandidatesSync(tmp.path).map(normalizedLocation)
      const existing = SkillPaths.runtimeSkillRootsSync(tmp.path).map(normalizedLocation)

      // Candidates include ALL well-known paths regardless of existence.
      expect(candidates).toContain(normalizedLocation(path.join(tmp.path, ".codex", "skills")))

      // Existing only includes directories that exist. Without creating any directories,
      // only synergy native roots (which exist because .synergy/ dirs are created by
      // the project structure) should be present.
      expect(existing.length).toBeLessThan(candidates.length)
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("discovers skills from .synergy/skill/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skill", "test-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT + 1)
        const testSkill = skills.find((s) => s.name === "test-skill")
        expect(testSkill).toBeDefined()
        expect(testSkill!.description).toBe("A test skill for verification.")
        expect(normalizedLocation(testSkill!.location)).toContain("skill/test-skill/SKILL.md")
        // Verify builtin skills are also present
        const builtinSkill = skills.find((s) => s.builtin === true)
        expect(builtinSkill).toBeDefined()
      },
    })
  })

  test("discovers references from .synergy/skill/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skill", "reference-skill")
        await fs.mkdir(path.join(skillDir, "references", "nested"), { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: reference-skill
description: A test skill with references.
---

# Reference Skill

Read the reference files.
`,
        )
        await Bun.write(path.join(skillDir, "references", "guide.md"), "# Guide\n")
        await Bun.write(path.join(skillDir, "references", "nested", "extra.md"), "# Extra\n")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get("reference-skill")
        expect(skill).toBeDefined()
        expect(skill!.references).toEqual({
          "references/guide.md": "# Guide\n",
          "references/nested/extra.md": "# Extra\n",
        })
      },
    })
  })

  test("discovers multiple skills from .synergy/skill/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir1 = path.join(dir, ".synergy", "skill", "skill-one")
        const skillDir2 = path.join(dir, ".synergy", "skill", "skill-two")
        await Bun.write(
          path.join(skillDir1, "SKILL.md"),
          `---
name: skill-one
description: First test skill.
---

# Skill One
`,
        )
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT + 2)
        expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
        expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
      },
    })
  })

  test("discovers skills from .synergy/skills/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skills", "plural-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: plural-skill
description: A test skill in the plural skills directory.
---

# Plural Skill

Instructions here.
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT + 1)
        const testSkill = skills.find((s) => s.name === "plural-skill")
        expect(testSkill).toBeDefined()
        expect(testSkill!.description).toBe("A test skill in the plural skills directory.")
        expect(normalizedLocation(testSkill!.location)).toContain("skills/plural-skill/SKILL.md")
      },
    })
  })

  test("skips skills with missing frontmatter", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".synergy", "skill", "no-frontmatter")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `# No Frontmatter

Just some content without YAML frontmatter.
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT)
        expect(skills.every((s) => s.builtin === true)).toBe(true)
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.name).toBe("no-frontmatter")
      },
    })
  })

  test("skips malformed skill frontmatter without failing whole catalog", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const validSkillDir = path.join(dir, ".synergy", "skill", "valid-skill")
        const brokenSkillDir = path.join(dir, ".synergy", "skill", "broken-skill")
        await Bun.write(
          path.join(validSkillDir, "SKILL.md"),
          `---
name: valid-skill
description: Still loads.
---

# Valid Skill
`,
        )
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
        const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
        expect(skills.find((s) => s.name === "valid-skill")).toBeDefined()
        expect(skills.find((s) => s.name === "broken-skill")).toBeUndefined()
        expect(diagnostics.some((item) => item.name === "broken-skill")).toBe(true)
      },
    })
  })

  test("discovers skills from .claude/skills/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT + 1)
        const claudeSkill = skills.find((s) => s.name === "claude-skill")
        expect(claudeSkill).toBeDefined()
        expect(normalizedLocation(claudeSkill!.location)).toContain(".claude/skills/claude-skill/SKILL.md")
      },
    })
  })

  test("discovers global skills from ~/.claude/skills/ directory", async () => {
    await using tmp = await tmpdir({ git: true })

    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await createGlobalSkill(tmp.path)
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const skills = await Skill.all()
          expect(skills.length).toBe(BUILTIN_SKILL_COUNT + 1)
          const globalSkill = skills.find((s) => s.name === "global-test-skill")
          expect(globalSkill).toBeDefined()
          expect(globalSkill!.description).toBe("A global skill from ~/.claude/skills for testing.")
          expect(normalizedLocation(globalSkill!.location)).toContain(".claude/skills/global-test-skill/SKILL.md")
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("returns only builtin skills when no user skills exist", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        // Only builtin skills should be present
        expect(skills.length).toBe(BUILTIN_SKILL_COUNT)
        expect(skills.every((s) => s.builtin === true)).toBe(true)
        // Verify skill-creator is present
        const skillCreator = skills.find((s) => s.name === "skill-creator")
        expect(skillCreator).toBeDefined()
        expect(skillCreator!.content).toBeDefined()
      },
    })
  })

  test("includes the native Clarus participation skill without user configuration", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get("clarus-agent-participation")
        expect(skill?.builtin).toBe(true)
        expect(skill?.content).toContain("clarus_submit_task_result")
        expect(skill?.content).not.toContain("start-clarus-listener")
        expect(skill?.content).not.toContain("clarus.runtime.task.result")
      },
    })
  })

  test("synergy-config documents canonical agent and model settings", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get("synergy-config")
        if (!skill?.content) throw new Error("Expected the built-in synergy-config skill to have content")

        const agents = skill.references?.["references/agents.txt"]
        if (!agents) throw new Error("Expected synergy-config to include its agents reference")
        for (const field of ["modelRole", "visibleTo", "delegationGroups", "controlProfile", "defaultVariant"]) {
          expect(agents.split("\n").some((line) => line.startsWith(`| \`${field}\` |`))).toBe(true)
        }
        for (const field of ["tools", "maxSteps"]) {
          const row = agents.split("\n").find((line) => line.startsWith(`| \`${field}\` |`))
          expect(row).toContain("Deprecated")
        }

        const modelsDomain = skill.content.split("\n").find((line) => line.startsWith("| `10-models.jsonc` |"))
        expect(modelsDomain).toContain("`quick_switcher`")

        const models = skill.references?.["references/models.txt"]
        if (!models) throw new Error("Expected synergy-config to include its models reference")
        expect(models).toContain("## Role variants")
        expect(models).toContain('"role_variant"')
        expect(models).toContain('"thinking": "high"')
      },
    })
  })

  test("reload discovers project-local skill created after initial config state", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const initial = await Skill.all()
        expect(initial.length).toBe(BUILTIN_SKILL_COUNT)

        const skillDir = path.join(tmp.path, ".synergy", "skill", "late-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: late-skill
description: A project-local skill created after startup.
---

# Late Skill
`,
        )

        await Skill.reload()

        const skills = await Skill.all()
        const lateSkill = skills.find((s) => s.name === "late-skill")
        expect(lateSkill).toBeDefined()
        expect(normalizedLocation(lateSkill!.location)).toContain(".synergy/skill/late-skill/SKILL.md")
      },
    })
  })

  test("reload discovers project-local skill from subdirectory scope", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "packages", "app"), { recursive: true })
      },
    })

    const subdirScope = (
      await (await import("../../src/scope")).Scope.fromDirectory(path.join(tmp.path, "packages", "app"))
    ).scope

    await ScopeContext.provide({
      scope: subdirScope,
      fn: async () => {
        const skillDir = path.join(tmp.path, ".synergy", "skill", "root-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: root-skill
description: A root project skill discovered from a nested directory.
---

# Root Skill
`,
        )

        await Skill.reload()

        const skills = await Skill.all()
        const rootSkill = skills.find((s) => s.name === "root-skill")
        expect(rootSkill).toBeDefined()
        expect(normalizedLocation(rootSkill!.location)).toContain(".synergy/skill/root-skill/SKILL.md")
      },
    })
  })

  test("discovers OpenClaw global and workspace skills with source metadata", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await createSkill(
          dir,
          "skills/workspace-openclaw",
          `---
name: workspace-openclaw
description: Workspace OpenClaw skill.
metadata: {"openclaw":{"requires":{"env":["OPENCLAW_TOKEN"]}}}
---

# Workspace OpenClaw
`,
        )
      },
    })

    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await createSkill(
        tmp.path,
        ".openclaw/skills/global-openclaw",
        `---
name: global-openclaw
description: Global OpenClaw skill.
metadata: {"openclaw":{"requires":{"bins":["uv"]}}}
command-dispatch: tool
---

# Global OpenClaw
`,
      )

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const skills = await Skill.all()
          const workspaceSkill = skills.find((s) => s.name === "workspace-openclaw")
          const globalSkill = skills.find((s) => s.name === "global-openclaw")

          expect(workspaceSkill).toBeDefined()
          expect(workspaceSkill!.source).toBe("openclaw")
          expect(workspaceSkill!.scope).toBe("workspace")
          expect(workspaceSkill!.compatibility?.level).toBe("partial")
          expect(workspaceSkill!.rawFrontmatter?.metadata).toBeDefined()

          expect(globalSkill).toBeDefined()
          expect(globalSkill!.source).toBe("openclaw")
          expect(globalSkill!.scope).toBe("global")
          expect(globalSkill!.compatibility?.unsupported).toContain(
            "OpenClaw command-dispatch is not implemented in Synergy.",
          )
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("discovers Codex skills and supports Skill.md entry files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await createSkill(
          dir,
          ".codex/skills/codex-skill",
          `---
name: codex-skill
description: Codex skill file.
---

# Codex Skill
`,
          "Skill.md",
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        const codexSkill = skills.find((s) => s.name === "codex-skill")
        expect(codexSkill).toBeDefined()
        expect(codexSkill!.source).toBe("codex")
        expect(codexSkill!.scope).toBe("project")
        expect(normalizedLocation(codexSkill!.location)).toContain(".codex/skills/codex-skill/Skill.md")
      },
    })
  })

  test("higher-precedence Synergy skills override external duplicates", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await createSkill(
          dir,
          ".claude/skills/shared-name",
          `---
name: shared-name
description: Claude version.
---

# Claude Version
`,
        )
        await createSkill(
          dir,
          ".synergy/skills/shared-name",
          `---
name: shared-name
description: Synergy version.
---

# Synergy Version
`,
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
        const skill = skills.find((s) => s.name === "shared-name")
        expect(skill).toBeDefined()
        expect(skill!.source).toBe("synergy")
        expect(skill!.description).toBe("Synergy version.")
        expect(diagnostics.some((item) => item.name === "shared-name")).toBe(true)
      },
    })
  })

  test("plugin skill duplicates are resolved with diagnostics", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-shared",
        description: "First plugin skill.",
        content: "# First Plugin Skill",
        pluginId: "plugin-one",
        pluginName: "Plugin One",
        pluginDir: path.join(tmp.path, "plugin-one"),
      },
      {
        name: "plugin-shared",
        description: "Second plugin skill.",
        content: "# Second Plugin Skill",
        pluginId: "plugin-two",
        pluginName: "Plugin Two",
        pluginDir: path.join(tmp.path, "plugin-two"),
      },
    ])

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
          const skill = skills.find((s) => s.name === "plugin-shared")
          expect(skill).toBeDefined()
          expect(skill!.source).toBe("plugin")
          expect(skill!.scope).toBe("external")
          expect(skill!.pluginId).toBe("plugin-two")
          expect(skill!.description).toBe("Second plugin skill.")
          expect(
            diagnostics.some((item) => item.name === "plugin-shared" && item.message.includes("plugin plugin-one")),
          ).toBe(true)
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
        },
      })
    }
  })

  test("project skills override plugin skill duplicates with diagnostics", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await createSkill(
          dir,
          ".synergy/skill/plugin-shared",
          `---
name: plugin-shared
description: Project version.
---

# Project Version
`,
        )
      },
    })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-shared",
        description: "Plugin version.",
        content: "# Plugin Version",
        pluginId: "plugin-one",
        pluginName: "Plugin One",
        pluginDir: path.join(tmp.path, "plugin-one"),
      },
    ])

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
          const skill = skills.find((s) => s.name === "plugin-shared")
          expect(skill).toBeDefined()
          expect(skill!.source).toBe("synergy")
          expect(skill!.scope).toBe("project")
          expect(skill!.description).toBe("Project version.")
          expect(
            diagnostics.some((item) => item.name === "plugin-shared" && item.message.includes("plugin plugin-one")),
          ).toBe(true)
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
        },
      })
    }
  })
})
