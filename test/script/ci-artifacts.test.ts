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
} from "../../script/ci/artifacts"

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
