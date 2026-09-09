import { expect, test } from "bun:test"
import { createExtensionOutlets } from "../src/context/extension-outlet"

test("required outlets and optional diagnostics reflect active mounts with idempotent cleanup", () => {
  const outlets = createExtensionOutlets()
  expect(outlets.missingRequired()).toEqual(["app.footer"])
  const first = outlets.register("app.footer")
  const second = outlets.register("app.footer")
  expect(outlets.missingRequired()).toEqual([])
  first()
  first()
  expect(outlets.mounted("app.footer")).toBe(true)
  second()
  expect(outlets.mounted("app.footer")).toBe(false)
  expect(outlets.mounted("composer.toolbar.right")).toBe(false)
  const optional = outlets.register("composer.toolbar.right")
  expect(outlets.mounted("composer.toolbar.right")).toBe(true)
  optional()
  expect(outlets.mounted("composer.toolbar.right")).toBe(false)
})
