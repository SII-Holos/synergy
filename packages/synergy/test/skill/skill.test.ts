import { describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { SkillSourceProfile } from "../../src/skill/source-profile"
import { tmpdir } from "../fixture/fixture"

const BUILTIN_SKILL_COUNT = BUILTIN_SKILLS.length

function normalizedPath(value: string) {
  return value.replace(/\\/g, "/")
}

function fileBacking(skill: Skill.Info) {
  if (skill.backing.kind !== "file") throw new Error(`Expected ${skill.name} to be file-backed`)
  return skill.backing
}

function memoryBacking(skill: Skill.Info) {
  if (skill.backing.kind !== "memory") throw new Error(`Expected ${skill.name} to be memory-backed`)
  return skill.backing
}

async function createSkill(
  baseDir: string,
  relativeDir: string,
  input: { name: string; description?: string; entry?: string; fields?: string; body?: string },
) {
  const directory = path.join(baseDir, relativeDir)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(
    path.join(directory, input.entry ?? "SKILL.md"),
    `---\nname: ${input.name}\ndescription: ${input.description ?? `${input.name} behavior.`}\n${input.fields ?? ""}---\n\n${input.body ?? `# ${input.name}`}\n`,
  )
}

describe.serial("skill discovery", () => {
  test("derives all runtime roots and existing trusted roots from supported locations", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      await fs.mkdir(path.join(tmp.path, ".codex", "skills"), { recursive: true })
      await fs.mkdir(path.join(tmp.path, ".agents", "skills"), { recursive: true })
      const candidates = SkillSourceProfile.allRootPaths(tmp.path).map(normalizedPath)
      const existing = SkillSourceProfile.existingRootPaths(tmp.path).map(normalizedPath)
      const filesystemRootCandidate = normalizedPath(path.join(path.parse(tmp.path).root, ".codex", "skills"))

      for (const expected of [
        ".synergy/skill",
        ".synergy/skills",
        ".synergy/config/skill",
        ".claude/skills",
        ".codex/skills",
        ".agents/skills",
        ".openclaw/skills",
        "skills",
      ]) {
        expect(candidates.some((root) => root.endsWith(expected))).toBe(true)
      }
      expect(existing).toContain(normalizedPath(path.join(tmp.path, ".codex", "skills")))
      expect(existing).toContain(normalizedPath(path.join(tmp.path, ".agents", "skills")))
      expect(candidates).not.toContain(filesystemRootCandidate)
      expect(existing.length).toBeLessThan(candidates.length)
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("discovers strict Synergy singular and plural roots without indexing resources", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await createSkill(directory, ".synergy/skill/singular-skill", { name: "singular-skill" })
        await createSkill(directory, ".synergy/skills/plural-skill", { name: "plural-skill" })
        await Bun.write(path.join(directory, ".synergy/skill/singular-skill/references/guide.md"), "# Guide\n")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills).toHaveLength(BUILTIN_SKILL_COUNT + 2)
        const singular = skills.find((skill) => skill.name === "singular-skill")!
        const plural = skills.find((skill) => skill.name === "plural-skill")!
        expect(singular.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        expect(normalizedPath(fileBacking(singular).entryFile)).toContain(".synergy/skill/singular-skill/SKILL.md")
        expect(normalizedPath(fileBacking(plural).entryFile)).toContain(".synergy/skills/plural-skill/SKILL.md")
        expect(singular).not.toHaveProperty("references")
      },
    })
  })

  test("loads legacy Synergy Skill.md entries through the compatibility shim", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (directory) =>
        createSkill(directory, ".synergy/skill/legacy-synergy", {
          name: "legacy-synergy",
          entry: "Skill.md",
          fields: "legacy-field: preserved-by-loader\n",
        }),
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get("legacy-synergy")
        expect(skill).toBeDefined()
        expect(Skill.runtimeCompatibility(skill!)).toBe("partial")
        expect(skill!.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        expect(fileBacking(skill!).entryFile).toMatch(/Skill\.md$/)
        const shim = skill!.diagnostics.find((diagnostic) => diagnostic.code === "skill.normalization_shim_applied")
        expect(shim?.reason.id).toBe("synergy-legacy-entry-load")
      },
    })
  })

  test("isolates missing and malformed strict manifests with canonical diagnostics", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, ".synergy/skill/no-frontmatter/SKILL.md"), "# Missing\n")
        await Bun.write(
          path.join(directory, ".synergy/skill/broken-skill/SKILL.md"),
          "---\nname: broken-skill\ndescription: bad: yaml\n---\n",
        )
        await createSkill(directory, ".synergy/skill/valid-skill", { name: "valid-skill" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const [skills, diagnostics] = await Promise.all([Skill.all(), Skill.diagnostics()])
        expect(skills.some((skill) => skill.name === "valid-skill")).toBe(true)
        expect(skills.some((skill) => skill.name === "no-frontmatter")).toBe(false)
        expect(skills.some((skill) => skill.name === "broken-skill")).toBe(false)
        expect(diagnostics.map((diagnostic) => diagnostic.name)).toEqual(
          expect.arrayContaining(["no-frontmatter", "broken-skill"]),
        )
      },
    })
  })

  test("discovers project and global Claude compatibility roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      await createSkill(tmp.path, ".claude/skills/project-claude", { name: "project-claude" })
      const project = path.join(tmp.path, "project")
      await fs.mkdir(project, { recursive: true })
      await createSkill(tmp.path, ".claude/skills/global-claude", { name: "global-claude" })

      const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const global = await Skill.get("global-claude")
          expect(global?.origin).toEqual({ kind: "filesystem", source: "claude", scope: "global" })
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("returns canonical memory-backed builtins", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        expect(skills).toHaveLength(BUILTIN_SKILL_COUNT)
        expect(skills.every((skill) => skill.origin.kind === "builtin")).toBe(true)
        expect(skills.some((skill) => skill.name === "skill-creator")).toBe(false)
        const creator = skills.find((skill) => skill.name === "synergy-skill-creator")!
        expect(Skill.Manifest.safeParse({ name: creator.name, description: creator.description }).success).toBe(true)
        const creatorBacking = memoryBacking(creator)
        expect(creatorBacking.content).toContain("Agent Skills standard")
        expect(creatorBacking.content).toContain("Synergy invocation extensions")
        expect(creatorBacking.content).toContain("vendor-only fields")
        expect(creatorBacking.content).toContain("user-invocable")
        expect(creatorBacking.content).toContain("disable-model-invocation")
        expect(creatorBacking.content).toContain("$ARGUMENTS[N]")
        expect(creatorBacking.content).toContain("$N")
        expect(creatorBacking.content).toContain("no-placeholder fallback")
        expect(creatorBacking.content).toContain("allowed-tools")
        expect(creatorBacking.content).toContain("has no authorization effect")
        expect(creatorBacking.references ?? {}).toEqual({})
        const config = skills.find((skill) => skill.name === "synergy-config")!
        const backing = memoryBacking(config)
        expect(backing.references?.["references/agents.txt"]).toContain("modelRole")
        expect(backing.references?.["references/models.txt"]).toContain("## Role variants")
      },
    })
  })

  test("builtin creator has no old identity, helper scripts, or generic references", async () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name)
    expect(names).toContain("synergy-skill-creator")
    expect(names).not.toContain("skill-creator")
    const creator = BUILTIN_SKILLS.find((skill) => skill.name === "synergy-skill-creator")!
    expect(Skill.Manifest.safeParse({ name: creator.name, description: creator.description }).success).toBe(true)
    expect(creator).not.toHaveProperty("scripts")
    expect(creator.references ?? {}).toEqual({})

    for (const root of [
      path.resolve(import.meta.dir, "../../src/skill/builtin/skill-creator"),
      path.resolve(import.meta.dir, "../../src/skill/builtin/synergy-skill-creator"),
    ]) {
      await expect(Bun.file(path.join(root, "scripts/init-skill.ts")).exists()).resolves.toBe(false)
      await expect(Bun.file(path.join(root, "scripts/package-skill.ts")).exists()).resolves.toBe(false)
      await expect(Bun.file(path.join(root, "scripts/validate-skill.ts")).exists()).resolves.toBe(false)
      await expect(Bun.file(path.join(root, "references/workflows.txt")).exists()).resolves.toBe(false)
      await expect(Bun.file(path.join(root, "references/output-patterns.txt")).exists()).resolves.toBe(false)
    }
  })

  test("reload discovers a strict project Skill created after initial state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Skill.get("late-skill")).toBeUndefined()
        await createSkill(tmp.path, ".synergy/skill/late-skill", { name: "late-skill" })
        await Skill.reload()
        expect(fileBacking((await Skill.get("late-skill"))!).entryFile).toContain("late-skill/SKILL.md")
      },
    })
  })

  test("canonicalizes and deduplicates a Skill reached through multiple symlinked roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const target = path.join(tmp.path, "fixtures", "linked-skill")
    await createSkill(tmp.path, "fixtures/linked-skill", { name: "linked-skill" })
    await fs.mkdir(path.join(tmp.path, ".synergy", "skill"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, ".claude", "skills"), { recursive: true })
    await fs.symlink(target, path.join(tmp.path, ".synergy", "skill", "linked-skill"), "dir")
    await fs.symlink(target, path.join(tmp.path, ".claude", "skills", "linked-skill"), "dir")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = (await Skill.get("linked-skill"))!
        expect(skill.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        expect(fileBacking(skill)).toEqual({
          kind: "file",
          baseDir: await fs.realpath(target),
          entryFile: await fs.realpath(path.join(target, "SKILL.md")),
        })
        expect(skill.diagnostics.some((diagnostic) => diagnostic.code === "skill.candidate_shadowed")).toBe(false)
      },
    })
  })

  test("chooses the highest-ranked source when symlinked roots share one canonical Skill", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      const project = path.join(tmp.path, "project")
      const target = path.join(tmp.path, "fixtures", "ranked-link")
      await createSkill(tmp.path, "fixtures/ranked-link", { name: "ranked-link" })
      await fs.mkdir(path.join(tmp.path, ".synergy", "skill"), { recursive: true })
      await fs.mkdir(path.join(project, ".claude", "skills"), { recursive: true })
      await fs.symlink(target, path.join(tmp.path, ".synergy", "skill", "ranked-link"), "dir")
      await fs.symlink(target, path.join(project, ".claude", "skills", "ranked-link"), "dir")

      const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const skill = (await Skill.get("ranked-link"))!
          expect(skill.origin).toEqual({ kind: "filesystem", source: "claude", scope: "project" })
          expect(fileBacking(skill).entryFile).toBe(await fs.realpath(path.join(target, "SKILL.md")))
          expect(skill.diagnostics.some((diagnostic) => diagnostic.code === "skill.candidate_shadowed")).toBe(false)
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("project Synergy candidates win over vendor candidates with a shadow reason", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await createSkill(directory, ".claude/skills/shared-name", {
          name: "shared-name",
          description: "Claude version.",
        })
        await createSkill(directory, ".synergy/skill/shared-name", {
          name: "shared-name",
          description: "Synergy version.",
        })
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = (await Skill.get("shared-name"))!
        expect(skill.description).toBe("Synergy version.")
        expect(skill.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        expect(skill.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "skill.candidate_shadowed",
            reason: expect.objectContaining({ kind: "precedence" }),
          }),
        )
        expect(Skill.runtimeCompatibility(skill)).toBe("native")
      },
    })
  })

  test("prefers the nearest ancestor root before singular versus plural root spelling", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "project")
    await createSkill(tmp.path, ".synergy/skill/ancestor-priority", {
      name: "ancestor-priority",
      description: "Parent singular root.",
    })
    await createSkill(project, ".synergy/skills/ancestor-priority", {
      name: "ancestor-priority",
      description: "Nearest plural root.",
    })

    const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const skill = (await Skill.get("ancestor-priority"))!
        expect(skill.description).toBe("Nearest plural root.")
        expect(normalizedPath(fileBacking(skill).entryFile)).toContain(
          "project/.synergy/skills/ancestor-priority/SKILL.md",
        )
      },
    })
  })

  test("preserves compatible names for programmatic plugin Skills", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "Research Helper",
        description: "Legacy plugin Skill name.",
        content: "# Research Helper",
        contributionId: "research-helper",
        pluginId: "legacy-plugin",
        pluginDir: path.join(tmp.path, "legacy-plugin"),
      },
    ])
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          expect(await Skill.get("Research Helper")).toMatchObject({
            name: "Research Helper",
            origin: { kind: "plugin", pluginID: "legacy-plugin", contributionID: "research-helper" },
          })
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
    }
  })

  test("plugin duplicates use stable plugin and contribution identity", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-shared",
        description: "Second plugin skill.",
        content: "# Second",
        contributionId: "skill-two",
        pluginId: "plugin-two",
        pluginDir: path.join(tmp.path, "plugin-two"),
      },
      {
        name: "plugin-shared",
        description: "First plugin skill.",
        content: "# First",
        contributionId: "skill-one",
        pluginId: "plugin-one",
        pluginDir: path.join(tmp.path, "plugin-one"),
      },
    ])
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const skill = (await Skill.get("plugin-shared"))!
          expect(skill.origin).toEqual({ kind: "plugin", pluginID: "plugin-one", contributionID: "skill-one" })
          expect(skill.description).toBe("First plugin skill.")
          expect(skill.diagnostics).toContainEqual(expect.objectContaining({ code: "skill.candidate_shadowed" }))
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
    }
  })

  test("project filesystem candidates outrank plugin candidates", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (directory) =>
        createSkill(directory, ".synergy/skill/plugin-shared", {
          name: "plugin-shared",
          description: "Project version.",
        }),
    })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-shared",
        description: "Plugin version.",
        content: "# Plugin",
        contributionId: "shared",
        pluginId: "plugin-one",
        pluginDir: path.join(tmp.path, "plugin-one"),
      },
    ])
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const skill = (await Skill.get("plugin-shared"))!
          expect(skill.description).toBe("Project version.")
          expect(skill.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
    }
  })
})
