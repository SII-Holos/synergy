import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Skill } from "../../src/skill/skill"

test("explicit Skill snapshots use the canonical resolver without ancestor discovery or stale contents", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const root = path.join(runtime.host.root, "selected")
    const filename = path.join(root, "team-work", "SKILL.md")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const write = (text: string) => fs.writeFile(filename, `---\nname: team-work\ndescription: ${text}\n---\n${text}`)
    await write("First")
    const input = {
      roots: [
        {
          source: "synergy" as const,
          scope: "project" as const,
          sourceRank: 100,
          scopeRank: 40,
          rootRank: 1,
          path: root,
          acceptedEntryNames: ["SKILL.md"],
          validation: "strict" as const,
        },
      ],
    }
    expect(Object.keys((await Skill.snapshot(input)).skills)).toEqual(["team-work"])
    const published = Skill.Info.parse({
      name: "team-work",
      description: "Published",
      invocation: { user: true, model: true },
      origin: { kind: "plugin", pluginID: "organization", contributionID: "team" },
      backing: { kind: "memory", content: "Published" },
      diagnostics: [],
    })
    const merged = await Skill.snapshot({ ...input, entries: [{ info: published, rank: [30, 100, 0, "team"] }] })
    expect(merged.skills["team-work"]?.description).toBe("First")
    expect(merged.diagnostics).toContainEqual(
      expect.objectContaining({ code: "skill.candidate_shadowed", name: "team-work" }),
    )
    await write("Updated")
    expect((await Skill.snapshot(input)).skills["team-work"]?.description).toBe("Updated")
    expect(Object.keys((await Skill.snapshot({ roots: [] })).skills)).toEqual([])
  })
})
