import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BUILD_INPUTS,
  buildCacheIdentity,
  buildCommands,
  buildIdentity,
  publishBuild,
  restoreBuild,
  mapFiles,
} from "../../script/ci/artifacts"

test("file operations overlap with bounded pressure and preserve inventory order", async () => {
  let active = 0
  let peak = 0
  const values = Array.from({ length: 40 }, (_, index) => index)
  expect(
    await mapFiles(values, async (value) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep((value % 4) + 1)
      active--
      return value
    }),
  ).toEqual(values)
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(16)
  expect(active).toBe(0)
})

test("failed file operations settle active siblings before publication can stop", async () => {
  let active = 0
  await expect(
    mapFiles([0, 1, 2, 3], async (value) => {
      active++
      try {
        if (value === 0) throw new Error("changed output")
        await Bun.sleep(10)
        return value
      } finally {
        active--
      }
    }),
  ).rejects.toThrow("changed output")
  expect(active).toBe(0)
})

async function inputs(root: string) {
  for (const file of BUILD_INPUTS) await Bun.write(path.join(root, file), "fixture inputs")
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({
      workspaces: { packages: ["packages/plugin", "packages/shared"] },
    }),
  )
  await Bun.write(
    path.join(root, "packages/plugin/package.json"),
    JSON.stringify({
      name: "@fixture/plugin",
      dependencies: { "@fixture/shared": "workspace:*" },
      scripts: { build: "compile" },
    }),
  )
  await Bun.write(
    path.join(root, "packages/shared/package.json"),
    JSON.stringify({ name: "@fixture/shared", scripts: { build: "compile" } }),
  )
  await Bun.write(path.join(root, "packages/local-runtime/.artifacts/pty/library"), "verified PTY")
  await Bun.write(path.join(root, "packages/shared/src/index.ts"), "export const value = 1")
  await Bun.write(path.join(root, "packages/shared/dist/index.js"), "verified dependency")
  await Bun.write(path.join(root, "packages/local-runtime/sandbox-assets/linux-x64/synergy-sandbox-linux"), "helper")
}

test("build identity invalidates native process artifacts when their implementation changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-build-native-"))
  try {
    await inputs(root)
    for (const file of ["Cargo.toml", "Cargo.lock", "src/lib.rs"]) {
      const source = path.join(root, "packages/local-runtime/src/process/native-pty", file)
      const before = await buildIdentity(root)
      await Bun.write(source, `changed native input: ${file}`)
      expect(await buildIdentity(root)).not.toBe(before)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("build identity follows newly added transitive workspace inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-build-graph-"))
  try {
    await inputs(root)
    expect(buildCommands(root).map((command) => path.relative(root, command.cwd))).toEqual([
      "packages/shared",
      "packages/plugin",
    ])
    const before = await buildIdentity(root)
    await Bun.write(path.join(root, "packages/shared/src/index.ts"), "export const value = 2")
    expect(await buildIdentity(root)).not.toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("shared preparation compiles the committed SDK without regenerating its inputs", () => {
  const recipes = buildCommands()
  expect(recipes.find((command) => command.cwd.endsWith("packages/sdk/js"))!.args).toContain("--compile-only")
  expect(recipes.at(-1)!.cwd).toEndWith("packages/plugin")
})

test("the shared Web build is restored once and rejects changed source or output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-build-web-"))
  const previous = process.env.SYNERGY_CI_WEB_BUILD
  try {
    await inputs(root)
    const manifest = await Bun.file(path.join(root, "package.json")).json()
    await Bun.write(
      path.join(root, "package.json"),
      JSON.stringify({ ...manifest, workspaces: { packages: ["packages/plugin", "packages/shared", "apps/web"] } }),
    )
    await Bun.write(
      path.join(root, "apps/web/package.json"),
      JSON.stringify({ name: "web", dependencies: { "@fixture/plugin": "workspace:*" } }),
    )
    await Bun.write(path.join(root, "apps/web/src/app.ts"), "export const app = 1")
    await Bun.write(path.join(root, "packages/shared/src/types.d.ts"), "export interface Fixture {}")
    await symlink("../../packages/shared/src/types.d.ts", path.join(root, "apps/web/custom-elements.d.ts"))
    await Bun.write(path.join(root, "apps/web/dist/index.html"), "verified Web")
    await Bun.write(path.join(root, "packages/plugin/dist/index.js"), "verified plugin")
    await Bun.write(path.join(root, "packages/local-runtime/.artifacts/watcher/watcher"), "verified watcher")
    process.env.SYNERGY_CI_WEB_BUILD = "true"
    await publishBuild(root)
    await Bun.write(path.join(root, "apps/web/dist/index.html"), "damaged Web")
    await restoreBuild(root)
    expect(await Bun.file(path.join(root, "apps/web/dist/index.html")).text()).toBe("verified Web")
    await Bun.write(path.join(root, ".artifacts/ci/build/apps/web/dist/index.html"), "tampered")
    await expect(restoreBuild(root)).rejects.toThrow("changed")
    const before = await buildIdentity(root)
    await Bun.write(path.join(root, "apps/web/src/app.ts"), "export const app = 2")
    expect(await buildIdentity(root)).not.toBe(before)
    await Bun.write(path.join(root, "packages/shared/src/other.d.ts"), "export interface Fixture {}")
    const linked = await buildIdentity(root)
    await rm(path.join(root, "apps/web/custom-elements.d.ts"))
    await symlink("../../packages/shared/src/other.d.ts", path.join(root, "apps/web/custom-elements.d.ts"))
    expect(await buildIdentity(root)).not.toBe(linked)
    await rm(path.join(root, "apps/web/custom-elements.d.ts"))
    await symlink(os.tmpdir(), path.join(root, "apps/web/custom-elements.d.ts"))
    await expect(buildIdentity(root)).rejects.toThrow("outside")
  } finally {
    if (previous === undefined) delete process.env.SYNERGY_CI_WEB_BUILD
    else process.env.SYNERGY_CI_WEB_BUILD = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("build outputs transfer between compatible runners during an image rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-build-images-"))
  const previous = process.env.ImageVersion
  try {
    await inputs(root)
    await Bun.write(path.join(root, "packages/plugin/dist/index.js"), "verified plugin")
    await Bun.write(path.join(root, "packages/local-runtime/.artifacts/watcher/watcher"), "verified watcher")
    process.env.ImageVersion = "20260907.300.1"
    const key = await buildCacheIdentity(root)
    await publishBuild(root)
    process.env.ImageVersion = "20260920.314.1"
    expect(await buildCacheIdentity(root)).not.toBe(key)
    await restoreBuild(root)
    expect(await Bun.file(path.join(root, "packages/plugin/dist/index.js")).text()).toBe("verified plugin")
  } finally {
    if (previous === undefined) delete process.env.ImageVersion
    else process.env.ImageVersion = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("build reuse validates inputs, bytes, modes and complete inventory before replacing outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-build-"))
  const plugin = "packages/plugin/dist/index.js"
  const watcher = "packages/local-runtime/.artifacts/watcher/watcher"
  try {
    await inputs(root)
    await Bun.write(path.join(root, plugin), "verified plugin")
    await Bun.write(path.join(root, watcher), "verified watcher")
    await chmod(path.join(root, watcher), 0o755)
    const pty = "packages/local-runtime/.artifacts/pty/native-library"
    await Bun.write(path.join(root, pty), "verified PTY")
    await publishBuild(root)
    await rm(path.join(root, pty))
    await Bun.write(path.join(root, plugin), "replaced output")
    await rm(path.join(root, "packages/shared/dist"), { recursive: true, force: true })
    await restoreBuild(root)
    expect(await Bun.file(path.join(root, plugin)).text()).toBe("verified plugin")
    expect(await Bun.file(path.join(root, pty)).text()).toBe("verified PTY")
    expect(await Bun.file(path.join(root, "packages/shared/dist/index.js")).text()).toBe("verified dependency")
    const bundle = path.join(root, ".artifacts/ci/build")
    await Bun.write(path.join(root, plugin), "leave intact on rejection")
    await Bun.write(path.join(bundle, plugin), "tampered")
    await expect(restoreBuild(root)).rejects.toThrow("changed")
    expect(await Bun.file(path.join(root, plugin)).text()).toBe("leave intact on rejection")
    await Bun.write(path.join(bundle, plugin), "verified plugin")
    await Bun.write(path.join(bundle, pty), "tampered native library")
    await expect(restoreBuild(root)).rejects.toThrow("changed")
    expect(await Bun.file(path.join(root, plugin)).text()).toBe("leave intact on rejection")
    await Bun.write(path.join(bundle, pty), "verified PTY")
    await chmod(path.join(bundle, watcher), 0o644)
    await expect(restoreBuild(root)).rejects.toThrow("changed")
    await chmod(path.join(bundle, watcher), 0o755)
    await Bun.write(path.join(bundle, "undeclared"), "unexpected")
    await expect(restoreBuild(root)).rejects.toThrow("inventory")
    await rm(path.join(bundle, "undeclared"))
    await symlink(path.join(root, "bun.lock"), path.join(bundle, "escape"))
    await expect(restoreBuild(root)).rejects.toThrow("symlink")
    await rm(path.join(bundle, "escape"))
    const before = await buildIdentity(root)
    await Bun.write(path.join(root, "bun.lock"), "changed dependency")
    expect(await buildIdentity(root)).not.toBe(before)
    await expect(restoreBuild(root)).rejects.toThrow("inputs differ")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
