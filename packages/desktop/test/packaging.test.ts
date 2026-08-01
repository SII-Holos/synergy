import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

interface ElectronBuilderConfig {
  mac?: {
    target?: Array<{ target?: string; arch?: string[] }>
  }
  pkg?: {
    scripts?: string
    installLocation?: string
  }
  win?: {
    executableName?: string
  }
  nsis?: {
    include?: string
    shortcutName?: string
  }
  linux?: {
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
  assertRuntimeAssets(runtimeDir: string, platform: string): void
}

async function createRuntimeFixture(binary: "synergy" | "synergy.exe" = "synergy") {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-after-pack-"))
  temporaryDirectories.push(runtimeDir)
  await Promise.all([
    fs.mkdir(path.join(runtimeDir, "bin"), { recursive: true }),
    fs.mkdir(path.join(runtimeDir, "app"), { recursive: true }),
    fs.mkdir(path.join(runtimeDir, "schema"), { recursive: true }),
    fs.mkdir(path.join(runtimeDir, "browser-runtime", "playwright-core", "lib"), { recursive: true }),
    fs.mkdir(path.join(runtimeDir, "lib", "onnxruntime-web"), { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(path.join(runtimeDir, "bin", binary), "runtime"),
    fs.writeFile(path.join(runtimeDir, "app", "index.html"), "<!doctype html>"),
    fs.writeFile(path.join(runtimeDir, "schema", "config.schema.json"), "{}"),
    fs.writeFile(path.join(runtimeDir, "browser-runtime", "playwright-core", "package.json"), "{}"),
    fs.writeFile(path.join(runtimeDir, "browser-runtime", "playwright-core", "index.js"), "runtime"),
    fs.writeFile(path.join(runtimeDir, "browser-runtime", "playwright-core", "lib", "coreBundle.js"), "runtime"),
    fs.writeFile(path.join(runtimeDir, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.mjs"), "runtime"),
    fs.writeFile(path.join(runtimeDir, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"), "runtime"),
  ])
  return runtimeDir
}

describe("desktop packaging", () => {
  test("copies runtime and unread indicator icon resources", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.extraResources).toContainEqual({
      from: "build/icon.ico",
      to: "icons/icon.ico",
    })
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

  test("pins Browser Host executable names to the signed manifest contract", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.browser-host.json", import.meta.url),
    ).json()) as BrowserHostBuilderConfig

    expect(config.win?.executableName).toBe("Synergy Browser Host")
    expect(config.linux?.executableName).toBe("synergy-browser-host")
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

  test("writes Desktop package version metadata beside the embedded runtime", async () => {
    const afterPackScript = await Bun.file(new URL("../script/after-pack.cjs", import.meta.url)).text()

    expect(afterPackScript).toContain("desktop-package.json")
    expect(afterPackScript).toContain("appInfo?.version")
  })

  test("rejects a runtime that cannot serve the Desktop application", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "app", "index.html"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(/app\/index\.html/)
  })

  test("requires the Linux sandbox helper", async () => {
    const runtimeDir = await createRuntimeFixture()

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "linux")).toThrow(/sandbox\/synergy-sandbox-linux/)
  })

  test("requires the Windows executable and sandbox helper", async () => {
    const runtimeDir = await createRuntimeFixture()

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "win32")).toThrow(/bin\/synergy\.exe/)
    await fs.writeFile(path.join(runtimeDir, "bin", "synergy.exe"), "runtime")
    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "win32")).toThrow(/sandbox\/synergy-sandbox-windows\.exe/)
  })

  test("rejects a runtime without its Playwright Core sidecar", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "browser-runtime", "playwright-core", "package.json"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /browser-runtime\/playwright-core\/package\.json/,
    )
  })

  test("rejects a runtime without its ONNX Web embedding sidecar", async () => {
    const runtimeDir = await createRuntimeFixture()
    await fs.rm(path.join(runtimeDir, "lib", "onnxruntime-web", "ort-wasm-simd-threaded.asyncify.wasm"))

    expect(() => afterPack.assertRuntimeAssets(runtimeDir, "darwin")).toThrow(
      /lib\/onnxruntime-web\/ort-wasm-simd-threaded\.asyncify\.wasm/,
    )
  })
})
