import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Flag } from "../../src/flag/flag"
import { ScopeContext } from "../../src/scope/context"
import { Skill } from "../../src/skill"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"
import { tmpdir } from "../fixture/fixture"

const BUILTIN_SKILL_COUNT = BUILTIN_SKILLS.length
const originalClaudeFlag = Flag.SYNERGY_DISABLE_CLAUDE_CODE_SKILLS

afterEach(() => {
  ;(Flag as { SYNERGY_DISABLE_CLAUDE_CODE_SKILLS: boolean }).SYNERGY_DISABLE_CLAUDE_CODE_SKILLS = originalClaudeFlag
})

async function createSkill(baseDir: string, relativeDir: string, input: { name: string; description?: string }) {
  const directory = path.join(baseDir, relativeDir)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(
    path.join(directory, "SKILL.md"),
    `---\nname: ${input.name}\ndescription: ${input.description ?? `${input.name} behavior.`}\n---\n\n# ${input.name}\n`,
  )
}

function filesystemSkills(skills: Skill.Info[]) {
  return skills.filter((skill) => skill.origin.kind === "filesystem")
}

describe.serial("skill compatibility toggles", () => {
  test("loads every compat source by default and reports per-source counts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await createSkill(directory, ".agents/skills/agents-one", { name: "agents-one" })
        await createSkill(directory, ".claude/skills/claude-one", { name: "claude-one" })
        await createSkill(directory, ".codex/skills/codex-one", { name: "codex-one" })
        await createSkill(directory, "skills/openclaw-one", { name: "openclaw-one" })
        await createSkill(directory, ".synergy/skill/synergy-one", { name: "synergy-one" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        const names = filesystemSkills(skills).map((skill) => skill.name)
        for (const expected of ["agents-one", "claude-one", "codex-one", "openclaw-one", "synergy-one"]) {
          expect(names).toContain(expected)
        }
        const counts = await Skill.sourceCounts()
        expect(counts.agents).toBe(1)
        expect(counts.claude).toBe(1)
        expect(counts.codex).toBe(1)
        expect(counts.openclaw).toBe(1)
        expect(counts.synergy).toBe(1)
      },
    })
  })

  test("disabling a source hides only its skills with no diagnostics noise", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { skills: { compatibility: { claude: false } } },
      init: async (directory) => {
        await createSkill(directory, ".claude/skills/claude-hidden", { name: "claude-hidden" })
        await createSkill(directory, ".synergy/skill/synergy-kept", { name: "synergy-kept" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const skills = await Skill.all()
        const names = filesystemSkills(skills).map((skill) => skill.name)
        expect(names).not.toContain("claude-hidden")
        expect(names).toContain("synergy-kept")

        const diagnostics = await Skill.diagnostics()
        const claudeDiagnostics = diagnostics.filter((diagnostic) => diagnostic.source === "claude")
        expect(claudeDiagnostics).toEqual([])
      },
    })
  })

  test("same-name copies fall through to the enabled runner-up when the winner's source is disabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { skills: { compatibility: { claude: false } } },
      init: async (directory) => {
        await createSkill(directory, ".claude/skills/duplicate", { name: "duplicate" })
        await createSkill(directory, ".synergy/skill/duplicate", { name: "duplicate" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const winner = await Skill.get("duplicate")
        expect(winner?.origin).toEqual({ kind: "filesystem", source: "synergy", scope: "project" })
        // The claude candidate is intentionally hidden, not shadowed: no
        // precedence diagnostic should reference it.
        const shadowDiagnostics = (await Skill.diagnostics()).filter(
          (diagnostic) => diagnostic.code === "skill.candidate_shadowed",
        )
        expect(shadowDiagnostics).toEqual([])
      },
    })
  })

  test("counts stay truthful for a disabled source", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { skills: { compatibility: { codex: false } } },
      init: async (directory) => {
        await createSkill(directory, ".codex/skills/codex-counted", { name: "codex-counted" })
        await createSkill(directory, ".agents/skills/agents-counted", { name: "agents-counted" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const counts = await Skill.sourceCounts()
        expect(counts.codex).toBe(1)
        expect(counts.agents).toBe(1)
        const names = filesystemSkills(await Skill.all()).map((skill) => skill.name)
        expect(names).not.toContain("codex-counted")
        expect(names).toContain("agents-counted")
      },
    })
  })

  test("claude env flag keeps winning over config (AND gate)", async () => {
    ;(Flag as { SYNERGY_DISABLE_CLAUDE_CODE_SKILLS: boolean }).SYNERGY_DISABLE_CLAUDE_CODE_SKILLS = true
    await using tmp = await tmpdir({
      git: true,
      config: { skills: { compatibility: { claude: true } } },
      init: async (directory) => {
        await createSkill(directory, ".claude/skills/claude-flagged", { name: "claude-flagged" })
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const names = filesystemSkills(await Skill.all()).map((skill) => skill.name)
        expect(names).not.toContain("claude-flagged")
      },
    })
  })

  test("reload applies a toggle change live through the config reload pipeline (R7)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await createSkill(directory, ".claude/skills/claude-live", { name: "claude-live" })
      },
    })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Initial state: claude skills load (no config).
        expect(filesystemSkills(await Skill.all()).map((skill) => skill.name)).toContain("claude-live")

        // Write the skills domain fragment, then reload through the same
        // config target path the settings save uses.
        const { ConfigDomain } = await import("../../src/config/domain")
        await fs.mkdir(path.join(tmp.path, ".synergy", "synergy.d"), { recursive: true })
        await Bun.write(
          ConfigDomain.filepath("skills", path.join(tmp.path, ".synergy")),
          JSON.stringify({ skills: { compatibility: { claude: false } } }, null, 2),
        )
        const { RuntimeReload } = await import("../../src/runtime/reload")
        const result = await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "test" })

        expect(result.cascaded).toContain("skill")
        expect(result.liveApplied).toContain("skills")
        expect(filesystemSkills(await Skill.all()).map((skill) => skill.name)).not.toContain("claude-live")
        expect(await Skill.sourceCounts()).toMatchObject({ claude: 1 })
      },
    })
  })
})
