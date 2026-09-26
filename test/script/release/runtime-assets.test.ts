import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertRuntimeManifest,
  requiredRuntimeArtifactPaths,
  writeRuntimeManifest,
} from "../../../script/release/shared/runtime-contract"
import {
  assertArchiveMemberNamesSafe,
  assertArchiveMembersSafe,
  createBinaryChecksums,
  packageBinaryAssets,
} from "../../../script/release/nodes/package-binary-assets"

const temporaryDirectories: string[] = []

async function createRuntimeFixture(root: string, name: string) {
  const runtimeDir = path.join(root, name)
  const required = requiredRuntimeArtifactPaths(name)
  for (const relative of required) {
    const file = path.join(runtimeDir, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${relative}\n`)
  }
  await writeRuntimeManifest(runtimeDir, name)
  return runtimeDir
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("release runtime asset contract", () => {
  test("seals every module file including filenames with spaces and rejects unlisted payloads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-module-seal-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const module = path.join(runtimeDir, "runtime/node_modules/example/Third Party.txt")
    await fs.mkdir(path.dirname(module), { recursive: true })
    await fs.writeFile(module, "approved module resource")
    await writeRuntimeManifest(runtimeDir, "synergy-darwin-arm64")
    await assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")
    await fs.writeFile(module, "tampered resource")
    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow("checksum mismatch")
    await fs.writeFile(module, "approved module resource")
    await fs.writeFile(path.join(path.dirname(module), "unlisted.js"), "unapproved code")
    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow("unlisted file")
  })
  test.each(["synergy-linux-x64", "synergy-darwin-arm64", "synergy-windows-x64"])(
    "requires module-owned assets for %s without executable-adjacent copies",
    (name) => {
      const required = requiredRuntimeArtifactPaths(name)
      expect(required).toContain("runtime/generation.json")
      expect(required).toContain("runtime/node_modules/@ericsanchezok/synergy-web-app/app/index.html")
      expect(required).toContain("runtime/node_modules/playwright-core/lib/coreBundle.js")
      expect(required.some((file) => file.includes("synergy-native-") && file.endsWith("/watcher.node"))).toBe(true)
      expect(required.some((file) => file.endsWith("/ort-wasm-simd-threaded.asyncify.wasm"))).toBe(true)
      expect(required).not.toContain("app/index.html")
      expect(required).not.toContain("watcher.node")
    },
  )
  test("keeps the musl watcher module without glibc-only optional helpers", () => {
    const required = requiredRuntimeArtifactPaths("synergy-linux-x64-baseline-musl")
    expect(required).toContain("runtime/node_modules/@ericsanchezok/synergy-native-linux-x64-musl/watcher.node")
    expect(required.some((file) => /ast-grep|vec0/.test(file))).toBe(false)
  })

  test("detects a required runtime file changed after manifest generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-manifest-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    await assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")

    await fs.writeFile(
      path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app", "index.html"),
      "tampered",
    )
    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime manifest checksum mismatch.*app\/index\.html/i,
    )
  })

  test("rejects a required runtime file replaced by a symbolic link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-symlink-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const appPath = path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app", "index.html")
    const linkedApp = path.join(root, "linked-app.html")
    await fs.rename(appPath, linkedApp)
    await fs.symlink(linkedApp, appPath)

    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime contains a symbolic link.*app\/index\.html/i,
    )
  })

  test("rejects duplicate runtime manifest paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-duplicate-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const manifestPath = path.join(runtimeDir, "runtime-manifest.sha256")
    const contents = await fs.readFile(manifestPath, "utf8")
    const duplicate = contents.split("\n").find((line) => line.endsWith("/app/index.html"))
    await fs.appendFile(manifestPath, `${duplicate}\n`)

    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime manifest contains a duplicate entry.*app\/index\.html/i,
    )
  })

  test("rejects a drive-letter path even when it exists inside the runtime fixture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-drive-path-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const relative = "C:/outside-runtime"
    const file = path.join(runtimeDir, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const data = Buffer.from("outside")
    await fs.writeFile(file, data)
    await fs.appendFile(
      path.join(runtimeDir, "runtime-manifest.sha256"),
      `${createHash("sha256").update(data).digest("hex")}  ${relative}\n`,
    )

    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime manifest contains an invalid entry/i,
    )
  })

  test("rejects a required runtime file beneath a symbolic-link directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-parent-link-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const appDirectory = path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app")
    const linkedDirectory = path.join(root, "linked-app")
    await fs.rename(appDirectory, linkedDirectory)
    await fs.symlink(linkedDirectory, appDirectory)

    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime contains a symbolic link.*app/i,
    )
  })

  test("rejects a symbolic link outside the runtime manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-extra-link-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    await fs.symlink(
      path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app", "index.html"),
      path.join(runtimeDir, "extra-link"),
    )

    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime contains a symbolic link.*extra-link/i,
    )
  })

  test.each(["../escape", "safe/../../escape", "/absolute", "C:/windows", "safe\\windows"])(
    "rejects unsafe release archive member path %s",
    (member) => {
      expect(() => assertArchiveMemberNamesSafe(`${member}\n`)).toThrow(/release archive contains an unsafe path/)
    },
  )

  test.each(["tar.gz", "zip"])("rejects a %s runtime archive containing a symbolic link", async (format) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-linked-archive-"))
    temporaryDirectories.push(root)
    const source = path.join(root, "source")
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, "target"), "target")
    await fs.symlink("target", path.join(source, "linked"))
    const archive = path.join(root, `runtime.${format}`)
    if (format === "tar.gz") {
      await Bun.$`tar -czf ${archive} target linked`.cwd(source)
    } else {
      await Bun.$`zip -y ${archive} target linked`.cwd(source).quiet()
    }

    await expect(assertArchiveMembersSafe(archive)).rejects.toThrow(/release archive contains a symbolic/i)
  })

  test("packages an archive that passes extracted runtime validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-archive-"))
    temporaryDirectories.push(root)
    const name = "synergy-linux-x64"
    await createRuntimeFixture(root, name)

    const [archive] = await packageBinaryAssets(root, [name])
    expect(await Bun.file(archive).exists()).toBe(true)
  })

  test("generates checksums for every CLI archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-checksums-"))
    temporaryDirectories.push(root)
    const first = path.join(root, "synergy-linux-x64.tar.gz")
    const second = path.join(root, "synergy-link-linux-x64.tar.gz")
    await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")])

    const checksumPath = await createBinaryChecksums("1.2.3", [first, second], root)
    const contents = await Bun.file(checksumPath).text()
    expect(path.basename(checksumPath)).toBe("Synergy-1.2.3-cli-checksums.txt")
    expect(contents).toContain(`${createHash("sha256").update("first").digest("hex")}  ${path.basename(first)}`)
    expect(contents).toContain(`${createHash("sha256").update("second").digest("hex")}  ${path.basename(second)}`)
  })
})
