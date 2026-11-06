import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Skill } from "../../src/skill/skill"
import { SkillSummary } from "../../src/skill/summary"
import { testRuntime } from "../support/runtime"

test("discovered skill summaries retain origin, invocation and compatibility diagnostics", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using fixture = await tmpdir({
      async init(directory) {
        for (const [root, name, extra] of [
          [".synergy/skill", "local-summary", "disable-model-invocation: true\ncompatibility: Requires Git\n"],
          [".claude/skills", "vendor-summary", "vendor-option: true\n"],
        ] as const) {
          await Bun.write(
            path.join(directory, root, name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Summary fixture.\n${extra}---\n\nFixture content.\n`,
          )
        }
      },
    })
    await ScopeContext.provide({
      scope: await fixture.scope(),
      async fn() {
        const local = SkillSummary.Info.parse(SkillSummary.from((await Skill.get("local-summary"))!))
        expect(local).toMatchObject({
          source: "synergy",
          scope: "project",
          invocation: { user: true, model: false },
          compatibility: { level: "native", warnings: [], unsupported: [] },
          declaredCompatibility: "Requires Git",
          exportable: true,
          entryFile: path.join(fixture.path, ".synergy/skill/local-summary/SKILL.md"),
        })
        const vendor = SkillSummary.Info.parse(SkillSummary.from((await Skill.get("vendor-summary"))!))
        expect(vendor.source).toBe("claude")
        expect(vendor.compatibility.warnings.length).toBeGreaterThan(0)
        expect(vendor.compatibility.unsupported).toHaveLength(1)
        expect(vendor.compatibility.unsupported[0]).toContain("vendor-option")
        expect(vendor.diagnostics).toContainEqual(
          expect.objectContaining({ code: "skill.vendor_field_unsupported", severity: "warning" }),
        )
        const builtin = SkillSummary.from((await Skill.get("agent-manage"))!)
        expect(builtin).toMatchObject({ source: "builtin", scope: "builtin", builtin: true, location: "builtin" })
        expect(builtin.entryFile).toBeUndefined()
      },
    })
  })
})

test("summary source counts omit absent sources and keep canonical display order", () => {
  expect(SkillSummary.fromSourceCounts({ codex: 2, synergy: 1, claude: 0 })).toEqual([
    { source: "synergy", count: 1 },
    { source: "codex", count: 2 },
  ])
})
