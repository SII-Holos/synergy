import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertRuntimeManifest } from "../../../script/release/shared/runtime-contract"
import { runtimeTarget, signingRuntime } from "./fixture/signing-runtime"

interface ElectronBuilderConfig {
  mac?: {
    icon?: string
    target?: Array<{ target?: string; arch?: string[] }>
  }
  pkg?: {
    scripts?: string
    installLocation?: string
  }
  win?: {
    icon?: string
    executableName?: string
    verifyUpdateCodeSignature?: boolean
  }
  nsis?: {
    include?: string
    shortcutName?: string
  }
  linux?: {
    icon?: string
    executableName?: string
    desktop?: { entry?: { Name?: string; StartupWMClass?: string } }
  }
  deb?: {
    afterInstall?: string
    afterRemove?: string
    depends?: string[]
  }
  extraResources?: Array<{
    from?: string
    to?: string
  }>
}

interface BrowserHostBuilderConfig {
  win?: { executableName?: string }
  linux?: { executableName?: string }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

const require = createRequire(import.meta.url)
const afterPack = require("../script/after-pack.cjs") as {
  default(context: { electronPlatformName: string; arch: string }): Promise<void>
  assertRuntimeAssets(runtimeDir: string, platform: string): void
  copyRuntime(
    source: string,
    destination: string,
    context: { electronPlatformName: string; arch: string; packager: { appInfo: { version: string } } },
  ): void
}

async function createRuntimeFixture(platform: "darwin" | "linux" | "win32" = "darwin", includeBinary = true) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-after-pack-"))
  temporaryDirectories.push(runtimeDir)
  const { requiredRuntimeArtifactPaths } = require("../../../script/release/shared/runtime-layout.cjs") as {
    requiredRuntimeArtifactPaths(name: string): string[]
  }
  await fs.mkdir(path.join(runtimeDir, "bin"), { recursive: true })
  const name = `synergy-${platform === "win32" ? "windows" : platform}-x64`
  for (const relative of requiredRuntimeArtifactPaths(name)) {
    if (relative.includes("synergy-sandbox-") || (!includeBinary && relative.startsWith("bin/"))) continue
    const filename = path.join(runtimeDir, relative)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, "runtime")
  }
  await writeRuntimeManifest(runtimeDir)
  return runtimeDir
}

async function writeRuntimeManifest(runtimeDir: string) {
  const files: string[] = []
  async function collect(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await collect(absolute)
      else if (entry.name !== "runtime-manifest.sha256") files.push(path.relative(runtimeDir, absolute))
    }
  }
  await collect(runtimeDir)
  const lines = await Promise.all(
    files.sort().map(async (relative) => {
      const data = await fs.readFile(path.join(runtimeDir, relative))
      return `${createHash("sha256").update(data).digest("hex")}  ${relative}`
    }),
  )
  await fs.writeFile(path.join(runtimeDir, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)
}

describe("desktop packaging", () => {
  test("requires explicit opt-in to package without a prepared runtime", async () => {
    const original = process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME
    const context = { electronPlatformName: "darwin", arch: "missing-signing-test" }
    try {
      delete process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME
      await expect(afterPack.default(context)).rejects.toThrow("Synergy runtime is missing")
      process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME = "1"
      expect(await afterPack.default(context)).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME
      else process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME = original
    }
  })

  test("accepts sealed module filenames with spaces and rejects unlisted code", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.writeFile(path.join(runtimeDir, "runtime/Third Party.txt"), "license")
    await writeRuntimeManifest(runtimeDir)
    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).not.toThrow()
    await fs.writeFile(path.join(runtimeDir, "runtime/unlisted.js"), "unapproved code")
    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/unlisted file/)
  })

  test("uses one product icon source and copies runtime indicator resources", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.extraResources).toContainEqual({
      from: "build/icon.png",
      to: "icons/icon.png",
    })
    expect(config.extraResources).toContainEqual({
      from: "build/unread-overlay.png",
      to: "icons/unread-overlay.png",
    })
    expect(config.extraResources).toContainEqual({
      from: "build/icon-unread.png",
      to: "icons/icon-unread.png",
    })
    expect(config.mac?.icon).toBe("build/icon.png")
    expect(config.win?.icon).toBe("build/icon.png")
    expect(config.linux?.icon).toBe("build/icon.png")
    for (const resource of config.extraResources ?? []) {
      expect(await Bun.file(new URL(`../${resource.from}`, import.meta.url)).exists()).toBe(true)
    }
  })

  test("keeps desktop shell executables separate from the public runtime CLI", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.win?.executableName).toBe("synergy-desktop")
    expect(config.linux?.executableName).toBe("synergy-desktop")
    expect(config.nsis?.shortcutName).toBe("Synergy")
    expect(config.linux?.desktop?.entry?.Name).toBe("Synergy")
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("synergy")
  })

  test("requires signature verification for Windows updates", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.win?.verifyUpdateCodeSignature).toBe(true)
  })

  test("configures installer hooks that expose the embedded runtime as synergy", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.mac?.target?.map((target) => target.target)).toContain("pkg")
    expect(config.pkg?.scripts).toBe("build/pkg-scripts")
    expect(config.pkg?.installLocation).toBe("/Applications")
    expect(config.nsis?.include).toBe("build/installer.nsh")
    expect(config.deb?.afterInstall).toBe("build/linux/deb-after-install.sh")
    expect(config.deb?.afterRemove).toBe("build/linux/deb-after-remove.sh")
    expect(config.deb?.depends).toContain("bubblewrap")
  })

  test("Windows installer publishes only the launcher directory, not runtime internals", async () => {
    const nsisScript = await Bun.file(new URL("../build/installer.nsh", import.meta.url)).text()

    expect(nsisScript).toContain("$INSTDIR\\bin\\synergy.cmd")
    expect(nsisScript).toContain("$INSTDIR\\resources\\synergy\\bin\\synergy.exe")
    expect(nsisScript).toContain(String.raw`FileWrite $0 "$\"$INSTDIR\resources\synergy\bin\synergy.exe$\" %*$\r$\n"`)
    expect(nsisScript).toContain("WriteRegExpandStr HKCU")
    expect(nsisScript).toContain("$INSTDIR\\bin")
    expect(nsisScript).not.toContain("WriteRegExpandStr HKLM")
    expect(nsisScript).not.toContain("$INSTDIR\\resources\\synergy\\bin;")
  })

  test("Windows installer de-dupes PATH by exact entry rather than prefix substring", async () => {
    const nsisScript = await Bun.file(new URL("../build/installer.nsh", import.meta.url)).text()

    expect(nsisScript).toContain("Call PathHasEntry")
    expect(nsisScript).toContain("StrCmp $R6 $R1 found")
    expect(nsisScript).toContain("!ifndef BUILD_UNINSTALLER\nFunction PathHasEntry")
    expect(nsisScript).toContain("!ifdef BUILD_UNINSTALLER\nFunction un.RemovePathEntry")
    expect(nsisScript).not.toContain("Call StrStr")
  })

  test("copies the sealed runtime and inventories Desktop version metadata even without signing", async () => {
    await using fixture = await signingRuntime()
    const destination = path.join(fixture.root, "unsigned-copy")
    afterPack.copyRuntime(fixture.runtimeDir, destination, {
      electronPlatformName: "darwin",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      packager: { appInfo: { version: "1.2.3" } },
    })
    expect(await Bun.file(path.join(destination, "desktop-package.json")).json()).toEqual({ version: "1.2.3" })
    await assertRuntimeManifest(destination, runtimeTarget)
    await fs.writeFile(path.join(destination, "desktop-package.json"), '{"version":"tampered"}')
    await expect(assertRuntimeManifest(destination, runtimeTarget)).rejects.toThrow("checksum mismatch")
  })

  test("rejects a runtime without its integrity manifest", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "runtime-manifest.sha256"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/runtime manifest is missing/i)
  })

  test("rejects a runtime whose manifest checksum no longer matches", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.writeFile(
      path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app/index.html"),
      "tampered",
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /runtime manifest checksum mismatch.*app\/index\.html/i,
    )
  })

  test("rejects a drive-letter path in the runtime manifest", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.appendFile(path.join(runtimeDir, "runtime-manifest.sha256"), `${"0".repeat(64)}  C:/outside-runtime\n`)

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /runtime manifest contains an invalid entry/i,
    )
  })

  test("rejects a runtime manifest entry that resolves through a symbolic link", async () => {
    const runtimeDir = await createRuntimeFixture()
    const appPath = path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app/index.html")
    const linkedApp = path.join(runtimeDir, "linked-app.html")
    await fs.rename(appPath, linkedApp)
    await fs.symlink(linkedApp, appPath)

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /runtime contains a symbolic link.*app\/index\.html/i,
    )
  })

  test("rejects a symbolic link outside the Desktop runtime manifest", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.symlink(
      path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app/index.html"),
      path.join(runtimeDir, "extra-link"),
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /runtime contains a symbolic link.*extra-link/i,
    )
  })

  test("accepts a sealed runtime without retired account tooling", async () => {
    const runtimeDir = await createRuntimeFixture()
    expect(
      await Bun.file(path.join(runtimeDir, "runtime/node_modules/@sii-holos/holos-cli/package.json")).exists(),
    ).toBe(false)
    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).not.toThrow()
  })

  test("rejects a runtime that cannot serve the Desktop application", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-web-app/app/index.html"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/app\/index\.html/)
  })

  test("requires the Linux sandbox helper", async () => {
    const runtimeDir = await createRuntimeFixture("linux")

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "linux")).toThrow(/synergy-native-.*\/synergy-sandbox-linux/)
  })

  test("requires the Windows executable and sandbox helper", async () => {
    const runtimeDir = await createRuntimeFixture("win32", false)

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "win32")).toThrow(/bin\/synergy\.exe/)
    await fs.writeFile(path.join(runtimeDir, "bin", "synergy.exe"), "runtime")
    await writeRuntimeManifest(runtimeDir)
    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "win32")).toThrow(
      /synergy-native-.*\/synergy-sandbox-windows\.exe/,
    )
  })

  test("rejects a runtime without its Desktop browser backend module", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "runtime/node_modules/@ericsanchezok/synergy-browser-runtime/package.json"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/synergy-browser-runtime\/package\.json/)
  })

  test("rejects a runtime without its ONNX Web embedding module", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(
      path.join(
        runtimeDir,
        "runtime/node_modules/@ericsanchezok/synergy-library/dist/lib/onnxruntime-web",
        "ort-wasm-simd-threaded.asyncify.wasm",
      ),
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /lib\/onnxruntime-web\/ort-wasm-simd-threaded\.asyncify\.wasm/,
    )
  })

  test("rejects a runtime without its SVG raster module", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(
      path.join(
        runtimeDir,
        "runtime/node_modules/@ericsanchezok/synergy-channel-feishu/dist/lib/resvg-wasm",
        "index_bg.wasm",
      ),
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/lib\/resvg-wasm\/index_bg\.wasm/)
  })
  test("rejects a runtime without its SVG raster fallback fonts", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(
      path.join(
        runtimeDir,
        "runtime/node_modules/@ericsanchezok/synergy-channel-feishu/dist/lib/resvg-wasm",
        "fonts",
        "noto-sans-sc-chinese-simplified-400-normal.woff2",
      ),
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /lib\/resvg-wasm\/fonts\/noto-sans-sc-chinese-simplified-400-normal\.woff2/,
    )
  })

  test("rejects a runtime without its SVG raster license notice", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(
      path.join(
        runtimeDir,
        "runtime/node_modules/@ericsanchezok/synergy-channel-feishu/dist/lib/resvg-wasm",
        "THIRD_PARTY_NOTICES.txt",
      ),
    )

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /lib\/resvg-wasm\/THIRD_PARTY_NOTICES\.txt/,
    )
  })
})
