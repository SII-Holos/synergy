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
  test.each([
    ["synergy-linux-x64", "bin/ast-grep", "vec0.so", "sandbox/synergy-sandbox-linux"],
    ["synergy-darwin-arm64", "bin/ast-grep", "vec0.dylib", undefined],
    ["synergy-windows-x64", "bin/ast-grep.exe", "vec0.dll", "sandbox/synergy-sandbox-windows.exe"],
  ] as const)("requires complete native and library assets for %s", (name, astGrep, sqliteVec, sandbox) => {
    const required = requiredRuntimeArtifactPaths(name)
    expect(required).toContain(astGrep)
    expect(required).toContain(sqliteVec)
    if (sandbox) expect(required).toContain(sandbox)
    expect(required).toContain("watcher.node")
    expect(required).toContain("lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs")
    expect(required).toContain("lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm")
    expect(required).toContain("lib/holos-cli/index.js")
    expect(required).toContain("lib/holos-cli/vendor/clarus-shared/index.js")
    expect(required).toContain("lib/holos-cli/node_modules/ws/package.json")
    expect(required).toContain("lib/holos-cli/node_modules/zod/package.json")
  })
  test("keeps the watcher binding in musl archives but excludes glibc-only helpers", () => {
    const required = requiredRuntimeArtifactPaths("synergy-linux-x64-baseline-musl")
    expect(required).not.toContain("bin/ast-grep")
    expect(required).not.toContain("vec0.so")
    expect(required).toContain("watcher.node")
    expect(required).toContain("sandbox/synergy-sandbox-linux")
  })

  test("detects a required runtime file changed after manifest generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-manifest-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    await assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")

    await fs.writeFile(path.join(runtimeDir, "app", "index.html"), "tampered")
    await expect(assertRuntimeManifest(runtimeDir, "synergy-darwin-arm64")).rejects.toThrow(
      /runtime manifest checksum mismatch.*app\/index\.html/i,
    )
  })

  test("rejects a required runtime file replaced by a symbolic link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-runtime-symlink-"))
    temporaryDirectories.push(root)
    const runtimeDir = await createRuntimeFixture(root, "synergy-darwin-arm64")
    const appPath = path.join(runtimeDir, "app", "index.html")
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
    const duplicate = contents.split("\n").find((line) => line.endsWith("  app/index.html"))
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
    const appDirectory = path.join(runtimeDir, "app")
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
    await fs.symlink(path.join(runtimeDir, "app", "index.html"), path.join(runtimeDir, "extra-link"))

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
