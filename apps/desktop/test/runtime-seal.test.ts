import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"
import { InstallationGenerations } from "../../../packages/plugin-host/src/installation/generations"
import { assertRuntimeManifest, writeRuntimeManifest } from "../../../script/release/shared/runtime-contract"
import { runtimeTarget, signingRuntime } from "./fixture/signing-runtime"

const require = createRequire(import.meta.url)
const { prepareRuntimeSeal } = require("../script/runtime-seal.cjs") as {
  prepareRuntimeSeal(directory: string): (signedFiles: Set<string>) => void
}

test("reseals only signed files and preserves the installation generation and required asset contract", async () => {
  await using fixture = await signingRuntime()
  const seed = path.join(fixture.runtimeDir, "runtime")
  const before = await InstallationGenerations.readSeed(seed)
  const assets = await fs.readFile(path.join(fixture.runtimeDir, "runtime-assets.txt"), "utf8")
  const native = Object.keys(before.files).find((file) => file.endsWith("/watcher.node"))!
  const file = path.join(seed, native)
  const seal = prepareRuntimeSeal(fixture.runtimeDir)
  await fs.appendFile(file, "signed bytes")
  seal(new Set([file]))
  const after = await InstallationGenerations.readSeed(seed)
  expect({ ...after, files: before.files, sha256: before.sha256 }).toEqual(before)
  expect(after.files[native]).not.toEqual(before.files[native])
  expect(Object.keys(after.files)).toEqual(Object.keys(before.files))
  expect(await fs.readFile(path.join(fixture.runtimeDir, "runtime-assets.txt"), "utf8")).toBe(assets)
  await assertRuntimeManifest(fixture.runtimeDir, runtimeTarget)
})

test("rejects a stale inner seal even if the outer inventory was regenerated", async () => {
  await using fixture = await signingRuntime()
  await fs.writeFile(path.join(fixture.runtimeDir, "runtime/unlisted.js"), "not in generation")
  await writeRuntimeManifest(fixture.runtimeDir, runtimeTarget)
  expect(() => prepareRuntimeSeal(fixture.runtimeDir)).toThrow("seed integrity mismatch")
})

test.each(["unlisted", "missing", "symlink", "parent-link", "generation", "resource", "assets", "inventory"])(
  "rejects %s changes during signing instead of blessing them in a new seal",
  async (change) => {
    await using fixture = await signingRuntime()
    const seed = path.join(fixture.runtimeDir, "runtime")
    const before = await InstallationGenerations.readSeed(seed)
    const native = path.join(
      seed,
      Object.keys(before.files).find((file) => file.endsWith("/watcher.node"))!,
    )
    const seal = prepareRuntimeSeal(fixture.runtimeDir)
    if (change === "unlisted") await fs.writeFile(path.join(seed, "unlisted.js"), "injected")
    if (change === "missing") await fs.rm(native)
    if (change === "symlink") {
      const target = path.join(fixture.root, "outside.node")
      await fs.rename(native, target)
      await fs.symlink(target, native)
    }
    if (change === "parent-link") {
      const target = path.join(fixture.root, "outside-module")
      await fs.rename(path.dirname(native), target)
      await fs.symlink(target, path.dirname(native))
    }
    if (change === "generation") await fs.appendFile(path.join(seed, "generation.json"), " ")
    if (change === "resource") {
      const resource = Object.keys(before.files).find((file) => file.endsWith("/PTY-LICENSE"))!
      await fs.appendFile(path.join(seed, resource), "changed resource")
    }
    if (change === "assets") await fs.appendFile(path.join(fixture.runtimeDir, "runtime-assets.txt"), "extra\n")
    if (change === "inventory") await fs.appendFile(path.join(fixture.runtimeDir, "runtime-manifest.sha256"), "extra\n")
    expect(() => seal(new Set([native]))).toThrow()
  },
)

test("rejects mutated payloads that the native signer did not visit", async () => {
  await using fixture = await signingRuntime()
  const seal = prepareRuntimeSeal(fixture.runtimeDir)
  await fs.appendFile(path.join(fixture.runtimeDir, "bin/synergy"), "not signed")
  expect(() => seal(new Set())).toThrow("checksum mismatch")
})

test("rejects initial payload tampering before any signing can begin", async () => {
  await using fixture = await signingRuntime()
  await fs.appendFile(path.join(fixture.runtimeDir, "bin/synergy"), "not approved")
  expect(() => prepareRuntimeSeal(fixture.runtimeDir)).toThrow("checksum mismatch")
})
