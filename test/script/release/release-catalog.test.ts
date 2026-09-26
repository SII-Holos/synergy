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

test("publishes the entire runtime closure and preserves the complete-product npm entry", async () => {
  for (const [id, entry] of Object.entries(RELEASE_CATALOG)) {
    if (["testing", "web", "desktop", "ui", "link", "benchmark"].includes(id)) continue
    const manifest = await Bun.file(path.join(REPO_ROOT, entry.directory, "package.json")).json()
    expect(entry.registry).toBe(manifest.name)
    expect(FIXED_REGISTRY_PACKAGES).toContain(manifest.name)
  }
  for (const suffix of [
    "cli",
    "core",
    "full",
    "web",
    "desktop",
    "web-app",
    "native-win32-arm64",
    "native-linux-arm64-musl",
  ])
    expect(FIXED_REGISTRY_PACKAGES).toContain(`@ericsanchezok/synergy-${suffix}`)
  expect(FIXED_REGISTRY_PACKAGES).toContain("@ericsanchezok/synergy")
  expect(new Set(FIXED_REGISTRY_PACKAGES).size).toBe(FIXED_REGISTRY_PACKAGES.length)
  expect(RUNTIME_RELEASE_TARGETS.core.registry).toBe("@ericsanchezok/synergy-cli")
  expect(RUNTIME_RELEASE_TARGETS.full.registry).toBe("@ericsanchezok/synergy")
  expect(RELEASE_CATALOG.link.registry).toBeNull()
})

test("both profiles use the canonical CLI launcher", () => {
  for (const target of Object.values(RUNTIME_RELEASE_TARGETS)) {
    expect(target.executable).toBe("synergy")
    expect(path.join(releasePackageDirectory(target.package), target.entrypoint)).toBe(
      path.join(REPO_ROOT, "packages/cli/src/launcher.ts"),
    )
  }
})

test("version updates include the split runtime packages once each", () => {
  expect(new Set(VERSION_MANAGED_PACKAGE_PATHS).size).toBe(VERSION_MANAGED_PACKAGE_PATHS.length)
  for (const id of ["cli", "harness", "localRuntime", "presets"] as const) {
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
