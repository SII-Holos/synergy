import { expect, test } from "bun:test"
import { resolveBuiltinPackage } from "../../src/installation/catalog"

for (const id of ["workflows", "connections"]) {
  test(`the ${id} installation alias resolves the official assembly preset`, () => {
    expect(resolveBuiltinPackage(id, "1.2.3")).toBe(`@ericsanchezok/synergy-${id}@1.2.3`)
  })
}
