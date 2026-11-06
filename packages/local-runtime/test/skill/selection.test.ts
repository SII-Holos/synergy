import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { Skill } from "../../src/skill/skill"
import { SkillSelection } from "../../src/skill/selection"
import { BUILTIN_SKILLS } from "../../src/skill/builtin"

async function inFixture(fn: () => Promise<void>) {
  await using fixture = await tmpdir({ git: true })
  const directory = path.join(fixture.path, ".synergy", "skill", "host-fixture")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    "---\nname: host-fixture\ndescription: Fixture skill\n---\nFixture",
  )
  return ScopeContext.provide({ scope: await fixture.scope(), fn })
}

test("an explicit host skill selection excludes native product skills and filesystem discovery", async () => {
  await using runtime = await testRuntime({
    register: () => SkillSelection.select({ builtins: [], filesystem: false }),
  })
  await runtime.run(() =>
    inFixture(async () => {
      expect(await Skill.all()).toEqual([])
      expect(Object.values(await Skill.sourceCounts()).every((count) => count === 0)).toBe(true)
      expect(() => SkillSelection.select({ builtins: [], filesystem: true })).toThrow("before opening the Runtime")
    }),
  )
})

test("skill selection is isolated between runtimes while the native product keeps its defaults", async () => {
  await using selected = await testRuntime({
    register: () => SkillSelection.select({ builtins: [BUILTIN_SKILLS[0]!.name], filesystem: false }),
  })
  await using product = await testRuntime()
  await selected.run(() =>
    inFixture(async () => {
      expect((await Skill.all()).map((skill) => skill.name)).toEqual([BUILTIN_SKILLS[0]!.name])
    }),
  )
  await product.run(() =>
    inFixture(async () => {
      const names = (await Skill.all()).map((skill) => skill.name)
      for (const builtin of BUILTIN_SKILLS) expect(names).toContain(builtin.name)
      expect(names).toContain("host-fixture")
    }),
  )
})

test("unknown builtin selections fail before catalog discovery", async () => {
  await expect(
    testRuntime({ register: () => SkillSelection.select({ builtins: ["unknown-host-skill"], filesystem: false }) }),
  ).rejects.toThrow("Unknown builtin skill")
})
