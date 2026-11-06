import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { InstallationGenerations } from "../../../packages/plugin-host/src/installation/generations"
import { assertRuntimeManifest, requiredRuntimeArtifactPaths } from "../../../script/release/shared/runtime-contract"
import { runtimeTarget, signingRuntime } from "./fixture/signing-runtime"

const desktopDir = fileURLToPath(new URL("..", import.meta.url))
const brandingFixture = fileURLToPath(new URL("./fixture/branding.js.txt", import.meta.url))
const { copyRuntime } = createRequire(import.meta.url)("../script/after-pack.cjs") as {
  copyRuntime(
    source: string,
    destination: string,
    context: { electronPlatformName: string; arch: string; packager: { appInfo: { version: string } } },
  ): void
}

function nativeRuntime() {
  return signingRuntime(async ({ root, app, runtimeDir }) => {
    const source = path.join(root, "native.c")
    const library = path.join(root, "native.dylib")
    const executable = path.join(app, "Contents/MacOS/Synergy")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(source, "int fixture_value(void) { return 42; }\nint main(void) { return 0; }\n")
    execFileSync("/usr/bin/clang", ["-dynamiclib", source, "-o", library], { stdio: "pipe" })
    execFileSync("/usr/bin/clang", [source, "-o", executable], { stdio: "pipe" })
    const driver = path.join(app, "Contents/Resources/computer/cua-driver")
    await fs.mkdir(path.dirname(driver), { recursive: true })
    await fs.copyFile(executable, driver)
    await fs.writeFile(
      path.join(app, "Contents/Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
        "<key>CFBundleExecutable</key><string>Synergy</string>" +
        "<key>CFBundleIdentifier</key><string>io.holosai.synergy.signing-test</string>" +
        "<key>CFBundlePackageType</key><string>APPL</string></dict></plist>",
    )
    for (const relative of requiredRuntimeArtifactPaths(runtimeTarget)) {
      if (/\.(dylib|node)$/.test(relative)) await fs.copyFile(library, path.join(runtimeDir, relative))
      else if (relative === "bin/synergy" || relative.endsWith("/ast-grep"))
        await fs.copyFile(executable, path.join(runtimeDir, relative))
    }
    const branding = path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-cli/dist/modules/branding.js")
    await fs.mkdir(path.dirname(branding), { recursive: true })
    await fs.copyFile(brandingFixture, branding)
  })
}

async function sign(app: string, mode = "success") {
  const child = Bun.spawn(["node", "--max-old-space-size=256", "test/fixture/sign-mac.cjs", app, mode], {
    cwd: desktopDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, diagnostics: code ? stdout + stderr : "" }
}

test("signer binary detection accepts packaged UTF-8 branding without unbounded allocation", () => {
  const result = spawnSync(
    "node",
    [
      "--max-old-space-size=256",
      "-e",
      `const { createRequire } = require("node:module")
       const builderRequire = createRequire(require.resolve("electron-builder"))
       const appRequire = createRequire(builderRequire.resolve("app-builder-lib"))
       const signerRequire = createRequire(appRequire.resolve("@electron/osx-sign"))
       const { isBinaryFile } = signerRequire("isbinaryfile")
       Promise.all([isBinaryFile(process.argv[1]), isBinaryFile(Buffer.from([0, 1, 2, 3]))])
         .then((results) => console.log(JSON.stringify(results)))
         .catch((error) => { console.error(error); process.exitCode = 1 })`,
      brandingFixture,
    ],
    { cwd: desktopDir, encoding: "utf8", timeout: 10_000 },
  )
  expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }).toEqual(
    {
      status: 0,
      signal: null,
      error: undefined,
      stderr: "",
    },
  )
  expect(JSON.parse(result.stdout)).toEqual([false, true])
}, 15_000)

test.skipIf(process.platform !== "darwin")(
  "native macOS signing seals the final module bytes before the app signature",
  async () => {
    await using fixture = await nativeRuntime()
    const source = path.join(fixture.root, "unsigned-runtime")
    await fs.rename(fixture.runtimeDir, source)
    copyRuntime(source, fixture.runtimeDir, {
      electronPlatformName: "darwin",
      arch: process.arch,
      packager: { appInfo: { version: "1.2.3" } },
    })
    const seed = path.join(fixture.runtimeDir, "runtime")
    const native = requiredRuntimeArtifactPaths(runtimeTarget).find((file) => file.endsWith("/libsqlite3.dylib"))!
    const nativeFile = path.join(fixture.runtimeDir, native)
    const originalHash = createHash("sha256")
      .update(await fs.readFile(nativeFile))
      .digest("hex")
    await InstallationGenerations.readSeed(seed)
    await assertRuntimeManifest(fixture.runtimeDir, runtimeTarget)

    expect(await sign(fixture.app)).toEqual({ code: 0, diagnostics: "" })
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", fixture.app], { stdio: "pipe" })
    const binaries = requiredRuntimeArtifactPaths(runtimeTarget)
      .filter((file) => /\.(dylib|node)$/.test(file) || file === "bin/synergy" || file.endsWith("/ast-grep"))
      .map((file) => path.join(fixture.runtimeDir, file))
    for (const file of [fixture.app, path.join(fixture.app, "Contents/Resources/computer/cua-driver"), ...binaries]) {
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], { stdio: "pipe" })
      const details = Bun.spawnSync(["/usr/bin/codesign", "--display", "--verbose=4", file])
      expect(details.exitCode).toBe(0)
      expect(details.stderr.toString()).toMatch(/flags=.*\([^)]*\bruntime\b/)
    }
    const finalHash = createHash("sha256")
      .update(await fs.readFile(nativeFile))
      .digest("hex")
    expect(finalHash).not.toBe(originalHash)
    const sealed = await InstallationGenerations.readSeed(seed)
    expect(sealed.files[native.slice("runtime/".length)]).toEqual({ kind: "file", sha256: finalHash })
    expect(sealed.id).toBe(fixture.generation.id)
    await assertRuntimeManifest(fixture.runtimeDir, runtimeTarget)

    await fs.appendFile(nativeFile, "tampered")
    await expect(InstallationGenerations.readSeed(seed)).rejects.toThrow("integrity mismatch")
    await expect(assertRuntimeManifest(fixture.runtimeDir, runtimeTarget)).rejects.toThrow("checksum mismatch")
    expect(() =>
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", fixture.app], { stdio: "pipe" }),
    ).toThrow()
  },
  30_000,
)

test.skipIf(process.platform !== "darwin")(
  "signs config-only development apps without inventing a runtime",
  async () => {
    await using fixture = await nativeRuntime()
    await fs.rm(fixture.runtimeDir, { recursive: true, force: true })
    expect(await sign(fixture.app)).toEqual({ code: 0, diagnostics: "" })
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", fixture.app], { stdio: "pipe" })
    expect(await fs.stat(fixture.runtimeDir).catch(() => undefined)).toBeUndefined()
  },
)

test.skipIf(process.platform !== "darwin").each(["fail-child", "fail-app"])(
  "propagates real codesign errors from %s to the packager",
  async (mode) => {
    await using fixture = await nativeRuntime()
    const manifestPath = path.join(fixture.runtimeDir, "runtime-manifest.sha256")
    const before = await fs.readFile(manifestPath, "utf8")
    const result = await sign(fixture.app, mode)
    expect(result.code).not.toBe(0)
    expect(result.diagnostics).toContain("codesign")
    expect(result.diagnostics).toContain("missing-entitlements.plist")
    if (mode === "fail-child") expect(await fs.readFile(manifestPath, "utf8")).toBe(before)
    else {
      await InstallationGenerations.readSeed(path.join(fixture.runtimeDir, "runtime"))
      await assertRuntimeManifest(fixture.runtimeDir, runtimeTarget)
    }
  },
)
