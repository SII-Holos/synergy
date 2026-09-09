import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertRuntimeManifest,
  requiredRuntimeArtifactPaths,
  writeRuntimeManifest,
} from "../../../script/release/shared/runtime-contract"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function coreFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-core-artifact-"))
  temporaryDirectories.push(directory)
  for (const relative of requiredRuntimeArtifactPaths("synergy-darwin-arm64", "core")) {
    const file = path.join(directory, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, relative)
  }
  return directory
}

test("core artifacts retain the synergy executable and execution assets without product payloads", () => {
  const required = requiredRuntimeArtifactPaths("synergy-linux-x64", "core")
  expect(required).toContain("bin/synergy")
  expect(required).not.toContain("bin/ast-grep")
  expect(required).toContain("watcher.node")
  expect(required).toContain("sandbox/synergy-sandbox-linux")
  expect(required).toContain("schema/config.schema.json")
  expect(required).not.toContain("vec0.so")
  expect(required.some((file) => /^(app|browser-runtime|lib)\//.test(file))).toBe(false)
})

test("a complete core manifest validates as core but cannot pass the full product contract", async () => {
  const directory = await coreFixture()
  await writeRuntimeManifest(directory, "synergy-darwin-arm64", "core")
  await assertRuntimeManifest(directory, "synergy-darwin-arm64", "core")
  await expect(assertRuntimeManifest(directory, "synergy-darwin-arm64")).rejects.toThrow(/missing required entry/)
})

test.each([
  "app/index.html",
  "browser-runtime/extra.js",
  "lib/onnxruntime-web/extra.wasm",
  "lib/holos-cli/extra.js",
  "vec0.dylib",
])("rejects unlisted product payload %s in a core artifact", async (relative) => {
  const directory = await coreFixture()
  await writeRuntimeManifest(directory, "synergy-darwin-arm64", "core")
  const file = path.join(directory, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "unlisted product payload")
  await expect(assertRuntimeManifest(directory, "synergy-darwin-arm64", "core")).rejects.toThrow(
    /core runtime contains product asset/,
  )
  await expect(writeRuntimeManifest(directory, "synergy-darwin-arm64", "core")).rejects.toThrow(
    /core runtime contains product asset/,
  )
})

test("requires core assets to exist when writing and verifying a manifest", async () => {
  const directory = await coreFixture()
  await writeRuntimeManifest(directory, "synergy-darwin-arm64", "core")
  await fs.rm(path.join(directory, "watcher.node"))
  await expect(assertRuntimeManifest(directory, "synergy-darwin-arm64", "core")).rejects.toThrow(/file is missing/)
  await expect(writeRuntimeManifest(directory, "synergy-darwin-arm64", "core")).rejects.toThrow(
    /missing runtime artifact/,
  )
})
