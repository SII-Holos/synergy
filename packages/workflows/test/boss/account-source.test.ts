import { expect, test } from "bun:test"
import { BossRuntime } from "../../src/boss/boss-runtime"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("enabled Boss provisioning rejects an absent Channel account source", async () => {
  await using fixture = await tmpdir({ config: { boss: { enabled: true } } })
  await ScopeContext.provide({
    scope: await fixture.scope(),
    fn: async () => {
      await expect(BossRuntime.ensure()).rejects.toThrow("Boss Channel account source is not registered")
      const dispose = BossRuntime.registerAccountSource(async () => [])
      try {
        await expect(BossRuntime.ensure()).resolves.toBeUndefined()
      } finally {
        dispose()
      }
    },
  })
})
