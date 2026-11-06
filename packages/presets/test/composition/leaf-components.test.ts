import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"

for (const [owner, factory] of [
  ["agenda", "agenda"],
  ["light-loop", "lightLoop"],
  ["email", "email"],
  ["channels", "channels"],
]) {
  test(`${owner} composes without unrelated knowledge capabilities`, async () => {
    const module = await import(`../../../${owner}/src/component.ts`)
    const selected = RuntimeComponents.resolve([localRuntime({ workers: false }), module[factory]()])
    expect(selected.map((component) => component.id)).toEqual(["local-runtime", owner])
  })
}

test("Blueprint requires Note before opening any Runtime", async () => {
  const { blueprint } = await import("../../../blueprint/src/component")
  expect(() => RuntimeComponents.resolve([localRuntime({ workers: false }), blueprint()])).toThrow("requires note")
})
