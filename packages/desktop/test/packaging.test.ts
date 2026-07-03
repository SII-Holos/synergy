import { describe, expect, test } from "bun:test"

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
  }
  extraResources?: Array<{
    from?: string
    to?: string
  }>
}

describe("desktop packaging", () => {
  test("copies runtime icon resources for explicit Windows and Linux window icons", async () => {
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
  })

  test("Windows installer publishes only the launcher directory, not runtime internals", async () => {
    const nsisScript = await Bun.file(new URL("../build/installer.nsh", import.meta.url)).text()

    expect(nsisScript).toContain("$INSTDIR\\bin\\synergy.cmd")
    expect(nsisScript).toContain("$INSTDIR\\resources\\synergy\\bin\\synergy.exe")
    expect(nsisScript).toContain("WriteRegExpandStr HKCU")
    expect(nsisScript).toContain("$INSTDIR\\bin")
    expect(nsisScript).not.toContain("WriteRegExpandStr HKLM")
    expect(nsisScript).not.toContain("$INSTDIR\\resources\\synergy\\bin;")
  })

  test("Windows installer de-dupes PATH by exact entry rather than prefix substring", async () => {
    const nsisScript = await Bun.file(new URL("../build/installer.nsh", import.meta.url)).text()

    expect(nsisScript).toContain("Call PathHasEntry")
    expect(nsisScript).toContain("StrCmp $R6 $R1 found")
    expect(nsisScript).not.toContain("Call StrStr")
  })

  test("writes Desktop package version metadata beside the embedded runtime", async () => {
    const afterPackScript = await Bun.file(new URL("../script/after-pack.cjs", import.meta.url)).text()

    expect(afterPackScript).toContain("desktop-package.json")
    expect(afterPackScript).toContain("appInfo?.version")
  })
})
