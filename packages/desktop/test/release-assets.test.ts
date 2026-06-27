import { describe, expect, test } from "bun:test"
import {
  desktopChecksumsName,
  desktopPrimaryArtifactName,
  expectedDesktopPrimaryArtifacts,
  isDesktopUpdateMetadata,
} from "../src/release-assets.js"

describe("desktop release asset names", () => {
  test("matches the public primary artifact naming contract", () => {
    expect(desktopPrimaryArtifactName("1.2.3", "darwin", "arm64")).toBe("Synergy-darwin-arm64-1.2.3.dmg")
    expect(desktopPrimaryArtifactName("1.2.3", "win32", "x64")).toBe("Synergy-win32-x64-1.2.3.exe")
    expect(desktopPrimaryArtifactName("1.2.3", "linux", "x64")).toBe("Synergy-linux-x86_64-1.2.3.AppImage")
    expect(desktopPrimaryArtifactName("1.2.3", "linux", "arm64")).toBe("Synergy-linux-arm64-1.2.3.AppImage")
  })

  test("lists all expected primary artifacts", () => {
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toHaveLength(6)
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-darwin-x64-1.2.3.dmg")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-linux-x86_64-1.2.3.AppImage")
    expect(expectedDesktopPrimaryArtifacts("1.2.3")).toContain("Synergy-linux-arm64-1.2.3.AppImage")
  })

  test("names checksum and updater metadata predictably", () => {
    expect(desktopChecksumsName("1.2.3")).toBe("Synergy-1.2.3-checksums.txt")
    expect(isDesktopUpdateMetadata("latest.yml")).toBe(true)
    expect(isDesktopUpdateMetadata("latest-mac.yml")).toBe(true)
    expect(isDesktopUpdateMetadata("notes.md")).toBe(false)
  })
})
