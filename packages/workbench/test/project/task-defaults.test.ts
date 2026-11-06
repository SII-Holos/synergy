import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { ProjectTaskDefaults } from "../../src/project/task-defaults"

test("project defaults save independently, preserve other settings, reject stale saves and can inherit again", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(directory.path)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Config.domainUpdate("general", { username: "Owner" }, { root: path.join(directory.path, ".synergy") })
        const initial = await ProjectTaskDefaults.get()
        const next = await ProjectTaskDefaults.update({
          expected: initial.defaults,
          defaults: { defaultSessionWorkspace: "main", defaultSessionEnvironmentProfile: null },
        })
        expect(next.defaults.defaultSessionEnvironmentProfile).toBeNull()
        expect((await Config.current()).username).toBe("Owner")
        expect((await Config.globalResolved()).defaultSessionEnvironmentProfile).toBeUndefined()
        await expect(
          ProjectTaskDefaults.update({
            expected: initial.defaults,
            defaults: { defaultSessionEnvironmentProfile: "native" },
          }),
        ).rejects.toMatchObject({ name: "ProjectTaskDefaultsConflict" })
        await expect(
          ProjectTaskDefaults.update({
            expected: next.defaults,
            defaults: { defaultSessionEnvironmentProfile: "missing" },
          }),
        ).rejects.toThrow("profile")
        await ProjectTaskDefaults.update({ expected: next.defaults, defaults: {} })
        expect((await Config.current()).defaultSessionEnvironmentProfile).toBeUndefined()
        expect((await Config.current()).username).toBe("Owner")
      },
    })
  })
})
