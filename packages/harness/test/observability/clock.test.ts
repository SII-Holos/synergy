import { expect, test } from "bun:test"
import { ObservabilityClock } from "../../src/observability/clock"
import { migrationFixture } from "../migration/fixture"

test("observability identifiers cannot collide across independent Runtime lifetimes in one process", async () => {
  const identifiers = new Set<string>()
  for (let lifetime = 0; lifetime < 3; lifetime++) {
    await using runtime = await migrationFixture()
    runtime.run(() => {
      for (let index = 0; index < 20; index++) {
        const id = ObservabilityClock.id("iss")
        expect(identifiers.has(id)).toBe(false)
        identifiers.add(id)
      }
    })
  }
  expect(identifiers.size).toBe(60)
})
