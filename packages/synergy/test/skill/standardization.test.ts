import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command/command"
import { RuntimeReload } from "../../src/runtime/reload"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { SkillArchive } from "../../src/skill/archive"
import { SkillManifest } from "../../src/skill/manifest"
import { tmpdir } from "../fixture/fixture"

async function writeSkill(
  root: string,
  relativeDirectory: string,
  input: {
    name: string
    description?: string
    entry?: "SKILL.md" | "Skill.md"
    fields?: string
    body?: string
  },
) {
  const directory = path.join(root, relativeDirectory)
  await fs.mkdir(directory, { recursive: true })
  const entry = input.entry ?? "SKILL.md"
  await Bun.write(
    path.join(directory, entry),
    `---\nname: ${input.name}\ndescription: ${input.description ?? `${input.name} behavior.`}\n${input.fields ?? ""}---\n\n${input.body ?? `# ${input.name}`}\n`,
  )
}

describe.serial("skill standardization", () => {
  test.each([
    { label: "one-character name", value: { name: "a", description: "d" }, valid: true },
    { label: "64-character name", value: { name: "a".repeat(64), description: "d" }, valid: true },
    { label: "65-character name", value: { name: "a".repeat(65), description: "d" }, valid: false },
    { label: "uppercase name", value: { name: "Upper", description: "d" }, valid: false },
    { label: "leading hyphen", value: { name: "-leading", description: "d" }, valid: false },
    { label: "trailing hyphen", value: { name: "trailing-", description: "d" }, valid: false },
    { label: "consecutive hyphens", value: { name: "two--hyphens", description: "d" }, valid: false },
    { label: "one-character description", value: { name: "valid", description: "d" }, valid: true },
    { label: "1024-character description", value: { name: "valid", description: "d".repeat(1024) }, valid: true },
    { label: "1025-character description", value: { name: "valid", description: "d".repeat(1025) }, valid: false },
    {
      label: "500-character compatibility",
      value: { name: "valid", description: "d", compatibility: "c".repeat(500) },
      valid: true,
    },
    {
      label: "501-character compatibility",
      value: { name: "valid", description: "d", compatibility: "c".repeat(501) },
      valid: false,
    },
  ])("validates the strict manifest $label boundary", ({ value, valid }) => {
    expect(SkillManifest.Schema.safeParse(value).success).toBe(valid)
  })

  test.each([
    { userInvocable: undefined, disableModelInvocation: undefined, expected: { user: true, model: true } },
    { userInvocable: false, disableModelInvocation: undefined, expected: { user: false, model: true } },
    { userInvocable: undefined, disableModelInvocation: true, expected: { user: true, model: false } },
    { userInvocable: false, disableModelInvocation: true, expected: { user: false, model: false } },
  ])("normalizes independent invocation controls", ({ userInvocable, disableModelInvocation, expected }) => {
    const result = SkillManifest.normalizeProgrammatic({
      manifest: {
        name: "invocation-controls",
        description: "Invocation controls fixture.",
        userInvocable,
        disableModelInvocation,
      },
      source: "plugin",
    })
    expect(result.value?.invocation).toEqual(expected)
  })

  test("accepts allowed-tools without creating runtime authorization state", async () => {
    await using tmp = await tmpdir()
    const entryFile = path.join(tmp.path, "allowed-tools", "SKILL.md")
    await Bun.write(
      entryFile,
      "---\nname: allowed-tools\ndescription: Allowed tools fixture.\nallowed-tools: Bash Read\n---\n\n# Allowed tools\n",
    )

    const result = await SkillManifest.normalizeFile({ entryFile, source: "synergy", mode: "strict" })
    expect(result.diagnostics).toEqual([])
    expect(result.value).toMatchObject({ name: "allowed-tools", invocation: { user: true, model: true } })
    expect(result.value).not.toHaveProperty("allowed-tools")
    expect(result.value).not.toHaveProperty("allowedTools")
    expect(result.value).not.toHaveProperty("permission")
  })

  test("keeps agents strict while loading pre-standardization entries through a named shim", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeSkill(tmp.path, ".agents/skills/valid-agent", {
      name: "valid-agent",
      fields:
        "license: MIT\ncompatibility: Requires git.\nallowed-tools: Bash\nuser-invocable: false\ndisable-model-invocation: true\n",
    })
    await writeSkill(tmp.path, ".agents/skills/legacy-agent", {
      name: "legacy-agent",
      entry: "Skill.md",
      fields: "vendor-field: value\n",
    })
    await writeSkill(tmp.path, ".synergy/skill/invalid-strict", {
      name: "invalid-strict",
      fields: "vendor-field: value\n",
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const [valid, legacy, invalidStrict, diagnostics] = await Promise.all([
          Skill.get("valid-agent"),
          Skill.get("legacy-agent"),
          Skill.get("invalid-strict"),
          Skill.diagnostics(),
        ])

        expect(Skill.runtimeCompatibility(valid!)).toBe("native")
        expect(valid).toMatchObject({
          name: "valid-agent",
          declaredLicense: "MIT",
          declaredCompatibility: "Requires git.",
          invocation: { user: false, model: false },
          origin: { kind: "filesystem", source: "agents", scope: "project" },
          backing: { kind: "file", entryFile: expect.stringMatching(/SKILL\.md$/) },
          diagnostics: [],
        })

        expect(Skill.runtimeCompatibility(legacy!)).toBe("partial")
        expect(await SkillArchive.exportable(legacy!, tmp.path)).toBe(false)
        expect(legacy).toMatchObject({
          name: "legacy-agent",
          origin: { kind: "filesystem", source: "agents", scope: "project" },
          backing: { kind: "file", entryFile: expect.stringMatching(/Skill\.md$/) },
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "skill.vendor_field_unsupported", field: "vendor-field" }),
            expect.objectContaining({
              code: "skill.normalization_shim_applied",
              reason: expect.objectContaining({ id: "agents-pre-standardization-load" }),
            }),
          ]),
        })

        expect(invalidStrict).toBeUndefined()
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            code: "skill.manifest_invalid",
            severity: "error",
            name: "invalid-strict",
            source: "synergy",
          }),
        )
      },
    })
  })

  test("lenient vendor entries load through real roots and normalize invocation diagnostics", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      const project = path.join(tmp.path, "project")
      await fs.mkdir(project, { recursive: true })
      await writeSkill(project, ".claude/skills/claude-live", {
        name: "claude-live",
        entry: "Skill.md",
        fields: "user-invocable: false\ndisable-model-invocation: true\nclaude-only: true\n",
      })
      await writeSkill(project, ".codex/skills/codex-live", {
        name: "codex-live",
        entry: "Skill.md",
        fields: "user-invocable: false\ndisable-model-invocation: true\ncodex-only: true\n",
      })
      await writeSkill(tmp.path, ".openclaw/skills/openclaw-live", {
        name: "openclaw-live",
        fields: "user-invocable: false\ndisable-model-invocation: true\ncommand-dispatch: tool\n",
      })
      await writeSkill(project, "skills/workspace-live", {
        name: "workspace-live",
        entry: "Skill.md",
        fields: "workspace-only: true\n",
      })

      const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const skills = await Skill.all()
          for (const [name, source, scope] of [
            ["claude-live", "claude", "project"],
            ["codex-live", "codex", "project"],
            ["openclaw-live", "openclaw", "global"],
            ["workspace-live", "openclaw", "workspace"],
          ] as const) {
            expect(skills.find((skill) => skill.name === name)).toMatchObject({
              invocation: name === "workspace-live" ? { user: true, model: true } : { user: false, model: false },
              origin: { kind: "filesystem", source, scope },
              backing: { kind: "file", entryFile: expect.stringMatching(/Skill\.md|SKILL\.md/) },
              diagnostics: [expect.objectContaining({ code: "skill.vendor_field_unsupported" })],
            })
          }
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("user invocation controls Slash registration and reload accepts compatible entry names", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeSkill(tmp.path, ".codex/skills/hidden-skill", {
      name: "hidden-skill",
      entry: "Skill.md",
      fields: "user-invocable: false\n",
    })
    await writeSkill(tmp.path, ".codex/skills/visible-skill", {
      name: "visible-skill",
      entry: "Skill.md",
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Command.reload()
        expect(await Command.get("hidden-skill")).toBeUndefined()
        expect(await Command.get("visible-skill")).toMatchObject({ source: "skill" })
        expect(RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".codex/skills/visible-skill/Skill.md"))).toEqual(
          ["skill"],
        )
      },
    })
  })

  test("runtime Skill reload cascades into the Slash command catalog", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Command.reload()
        expect(await Command.get("reload-cascade")).toBeUndefined()
        await writeSkill(tmp.path, ".synergy/skill/reload-cascade", { name: "reload-cascade" })

        const result = await RuntimeReload.reload({ targets: ["skill"], scope: "project", reason: "test" })

        expect(result.executed).toEqual(expect.arrayContaining(["skill", "command"]))
        expect(result.cascaded).toContain("command")
        expect(await Command.get("reload-cascade")).toMatchObject({ source: "skill" })
      },
    })
  })

  test("reload detection covers every live root and applies entry exceptions per source", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      const project = path.join(tmp.path, "project")
      await fs.mkdir(project, { recursive: true })
      const strictRoots = [
        { root: path.join(project, ".synergy", "skill"), scope: "project" },
        { root: path.join(project, ".synergy", "skills"), scope: "project" },
        { root: path.join(tmp.path, ".synergy", "config", "skill"), scope: "global" },
        { root: path.join(tmp.path, ".synergy", "config", "skills"), scope: "global" },
        { root: path.join(tmp.path, ".synergy", "skill"), scope: "global" },
        { root: path.join(tmp.path, ".synergy", "skills"), scope: "global" },
      ] as const
      const agentsRoots = [
        { root: path.join(project, ".agents", "skills"), scope: "project" },
        { root: path.join(tmp.path, ".agents", "skills"), scope: "global" },
      ] as const
      const lenientRoots = [
        { root: path.join(project, ".claude", "skills"), scope: "project" },
        { root: path.join(project, ".codex", "skills"), scope: "project" },
        { root: path.join(project, "skills"), scope: "project" },
        { root: path.join(tmp.path, ".claude", "skills"), scope: "global" },
        { root: path.join(tmp.path, ".codex", "skills"), scope: "global" },
        { root: path.join(tmp.path, ".openclaw", "skills"), scope: "global" },
      ] as const
      const supported = [
        ...strictRoots.map(({ root, scope }, index) => ({
          file: path.join(root, `strict-${index}`, "SKILL.md"),
          scope,
        })),
        ...agentsRoots.flatMap(({ root, scope }, index) =>
          (["SKILL.md", "Skill.md"] as const).map((entry) => ({
            file: path.join(root, `agents-${index}-${entry}`, entry),
            scope,
          })),
        ),
        ...lenientRoots.flatMap(({ root, scope }, index) =>
          (["SKILL.md", "Skill.md"] as const).map((entry) => ({
            file: path.join(root, `lenient-${index}-${entry}`, entry),
            scope,
          })),
        ),
      ]
      await Promise.all(
        supported.map(({ file }) => Bun.write(file, "---\nname: reload-live\ndescription: live\n---\n")),
      )
      const rejected = strictRoots.map(({ root }, index) => path.join(root, `strict-rejected-${index}`, "Skill.md"))
      await Promise.all(
        rejected.map((file) => Bun.write(file, "---\nname: reload-rejected\ndescription: rejected\n---\n")),
      )

      const scope = (await (await import("../../src/scope")).Scope.fromDirectory(project)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          for (const fixture of supported) {
            expect(RuntimeReload.detectTargetsForFile(fixture.file)).toEqual(["skill"])
            expect(RuntimeReload.detectScopeForFile(fixture.file)).toBe(fixture.scope)
          }
          for (const file of rejected) {
            expect(RuntimeReload.detectTargetsForFile(file)).toEqual([])
          }
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("deterministic precedence records the winner and shadowed reason", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeSkill(tmp.path, ".claude/skills/shared-skill", {
      name: "shared-skill",
      description: "Claude candidate.",
    })
    await writeSkill(tmp.path, ".synergy/skill/shared-skill", {
      name: "shared-skill",
      description: "Synergy candidate.",
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skill = await Skill.get("shared-skill")
        expect(skill).toMatchObject({
          description: "Synergy candidate.",
          origin: { kind: "filesystem", source: "synergy", scope: "project" },
          diagnostics: [
            expect.objectContaining({
              code: "skill.candidate_shadowed",
              reason: expect.objectContaining({ winner: expect.any(String), shadowed: expect.any(String) }),
            }),
          ],
        })
      },
    })
  })
})
