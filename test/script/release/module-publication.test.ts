import { expect, test } from "bun:test"
import type { PackedArchive } from "../../../script/package-install-check"
import { modulePublishOrder } from "../../../script/release/shared/publish-modules"

const archive = (id: string, dependencies: Record<string, string> = {}, optionalDependencies = {}): PackedArchive => ({
  name: `@ericsanchezok/synergy-${id}`,
  version: "4.0.0",
  archive: `${id}.tgz`,
  manifest: { dependencies, optionalDependencies },
})

test("publishes required and optional first-party dependencies before their consumers", () => {
  const native = archive("native-darwin-arm64")
  const harness = archive("harness", {}, { [native.name]: native.version })
  const cli = archive("cli", { [harness.name]: harness.version })
  expect(modulePublishOrder([cli, harness, native]).map((pkg) => pkg.name)).toEqual([
    native.name,
    harness.name,
    cli.name,
  ])
})

test("rejects missing, duplicate, mismatched and cyclic publication inputs", () => {
  const harness = archive("harness")
  const cli = archive("cli", { [harness.name]: harness.version })
  expect(() => modulePublishOrder([cli])).toThrow("Missing")
  expect(() => modulePublishOrder([harness, harness])).toThrow("Duplicate")
  expect(() => modulePublishOrder([archive("cli", { [harness.name]: "3.0.0" }), harness])).toThrow("version")
  expect(() => modulePublishOrder([cli, archive("harness", { [cli.name]: cli.version })])).toThrow("cycle")
})

test("only Desktop application publication can be explicitly deferred until signed artifacts exist", () => {
  const desktop = archive("desktop", { "@ericsanchezok/synergy-desktop-app": "4.0.0" })
  expect(() => modulePublishOrder([desktop])).toThrow("Missing")
  expect(modulePublishOrder([desktop], ["@ericsanchezok/synergy-desktop-app"])).toEqual([desktop])
})
