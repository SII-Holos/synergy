import { describe, expect, test } from "bun:test"
import {
  browserHostArtifactName,
  browserHostManifestName,
  browserHostManifestSignatureName,
  desktopChecksumsName,
  desktopPortableArtifactNames,
  desktopPrimaryArtifactName,
  expectedBrowserHostArtifacts,
  expectedDesktopPrimaryArtifacts,
  isDesktopUpdateMetadata,
} from "../src/release-assets.js"

describe("desktop release asset names", () => {
  test("matches the public installer artifact naming contract", () => {
    expect(desktopPrimaryArtifactName("1.2.3", "darwin", "arm64")).toBe("Synergy-darwin-arm64-1.2.3.pkg")
    expect(desktopPrimaryArtifactName("1.2.3", "win32", "x64")).toBe("Synergy-win32-x64-1.2.3.exe")
    expect(desktopPrimaryArtifactName("1.2.3", "linux", "x64")).toBe("Synergy-linux-amd64-1.2.3.deb")
    expect(desktopPrimaryArtifactName("1.2.3", "linux", "arm64")).toBe("Synergy-linux-arm64-1.2.3.deb")
  })

  test("lists all expected primary installer artifacts", () => {
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toHaveLength(5)
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-darwin-x64-1.2.3.pkg")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-win32-x64-1.2.3.exe")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).not.toContain("Synergy-win32-arm64-1.2.3.exe")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-linux-amd64-1.2.3.deb")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-linux-arm64-1.2.3.deb")
  })

  test("lists portable desktop artifacts separately from installer artifacts", () => {
    expect(desktopPortableArtifactNames("1.2.3")).toContain("Synergy-darwin-arm64-1.2.3.dmg")
    expect(desktopPortableArtifactNames("1.2.3")).toContain("Synergy-darwin-arm64-1.2.3.zip")
    expect(desktopPortableArtifactNames("1.2.3")).toContain("Synergy-linux-x86_64-1.2.3.AppImage")
    expect(desktopPortableArtifactNames("1.2.3")).toContain("Synergy-linux-x64-1.2.3.tar.gz")
    expect(desktopPortableArtifactNames("1.2.3")).toContain("Synergy-linux-arm64-1.2.3.tar.gz")
    expect(desktopPortableArtifactNames("1.2.3")).not.toContain("Synergy-win32-arm64-1.2.3.zip")
  })

  test("names checksum and updater metadata predictably", () => {
    expect(desktopChecksumsName("1.2.3")).toBe("Synergy-1.2.3-checksums.txt")
    expect(isDesktopUpdateMetadata("latest.yml")).toBe(true)
    expect(isDesktopUpdateMetadata("latest-mac.yml")).toBe(true)
    expect(isDesktopUpdateMetadata("notes.md")).toBe(false)
  })

  test("names version-locked Browser Host artifacts and signed manifests", () => {
    expect(browserHostArtifactName("1.2.3", "darwin", "arm64")).toBe("synergy-browser-host-darwin-arm64-1.2.3.zip")
    expect(browserHostManifestName("1.2.3", "win32", "x64")).toBe("synergy-browser-host-win32-x64-1.2.3.manifest.json")
    expect(browserHostManifestSignatureName("1.2.3", "linux", "arm64")).toBe(
      "synergy-browser-host-linux-arm64-1.2.3.manifest.json.sig",
    )
    expect(expectedBrowserHostArtifacts("1.2.3")).toHaveLength(18)
  })
})
