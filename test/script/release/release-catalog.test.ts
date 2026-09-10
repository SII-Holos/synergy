import { expect, test } from "bun:test"
import path from "node:path"
import {
  FIXED_REGISTRY_PACKAGES,
  RELEASE_CATALOG,
  REPO_ROOT,
  RUNTIME_RELEASE_TARGETS,
  VERSION_MANAGED_PACKAGE_PATHS,
  releasePackageDirectory,
} from "../../../script/release/shared/packages"

test("preserves the public registry names and keeps core a profile of the same CLI", () => {
  expect(FIXED_REGISTRY_PACKAGES).toEqual([
    "@ericsanchezok/synergy-sdk",
    "@ericsanchezok/synergy-util",
    "@ericsanchezok/synergy-link-protocol",
    "@ericsanchezok/synergy-plugin",
    "@ericsanchezok/synergy-plugin-kit",
    "@ericsanchezok/synergy",
  ])
  expect(RUNTIME_RELEASE_TARGETS.core.executable).toBe("synergy")
  expect(RUNTIME_RELEASE_TARGETS.full.executable).toBe("synergy")
  expect(RUNTIME_RELEASE_TARGETS.core.registry).toBeNull()
  expect(RUNTIME_RELEASE_TARGETS.full.registry).toBe("@ericsanchezok/synergy")
  expect(RELEASE_CATALOG.link.registry).toBeNull()
})

test("resolves distinct core and product entrypoints under their owning packages", () => {
  for (const [profile, expected] of [
    ["core", "packages/cli/src/index.ts"],
    ["full", "packages/product-runtime/src/index.ts"],
  ] as const) {
    const target = RUNTIME_RELEASE_TARGETS[profile]
    expect(path.join(releasePackageDirectory(target.package), target.entrypoint)).toBe(path.join(REPO_ROOT, expected))
  }
  expect(releasePackageDirectory("web")).toBe(path.join(REPO_ROOT, "apps/web"))
  expect(releasePackageDirectory("desktop")).toBe(path.join(REPO_ROOT, "apps/desktop"))
})

test("version updates include the split runtime packages once each", () => {
  expect(new Set(VERSION_MANAGED_PACKAGE_PATHS).size).toBe(VERSION_MANAGED_PACKAGE_PATHS.length)
  for (const id of ["cli", "harness", "runtimeLocal", "productRuntime"] as const) {
    expect(VERSION_MANAGED_PACKAGE_PATHS).toContain(path.join(releasePackageDirectory(id), "package.json"))
  }
})

test("the local benchmark remains private and independently versioned", () => {
  expect(RELEASE_CATALOG.benchmark.registry).toBeNull()
  expect(VERSION_MANAGED_PACKAGE_PATHS).not.toContain(path.join(releasePackageDirectory("benchmark"), "package.json"))
})

test("the release catalog accounts for every workspace package", async () => {
  const root = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as {
    workspaces: { packages: string[] }
  }
  expect(
    Object.values(RELEASE_CATALOG)
      .map((entry) => entry.directory)
      .sort(),
  ).toEqual([...root.workspaces.packages].sort())
})
