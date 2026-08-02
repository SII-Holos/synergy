import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { desktopChecksumsName } from "../../../packages/desktop/src/release-assets"
import {
  assertDesktopAssetChecksums,
  assertDesktopAssetNames,
  expectedDesktopChecksumAssetNames,
  verifyPublishedDesktopChecksums,
} from "../../../script/release/nodes/verify-desktop-assets"
import type { ReleaseState } from "../../../script/release/shared/packages"

function checksum(contents: string) {
  return createHash("sha256").update(contents).digest("hex")
}

function releaseState(): ReleaseState {
  return {
    kind: "stable",
    version: "1.2.3",
    channel: "next",
    promoteTag: "latest",
    createdAt: "2026-08-02T00:00:00.000Z",
    registryPackages: [],
    binaryAssets: [],
    binaryChecksums: null,
    desktopAssets: [],
    desktopChecksums: null,
    desktopUpdateMetadata: [],
    releaseTag: "v1.2.3",
    githubReleaseID: null,
    githubReleaseTagName: null,
  }
}

describe("desktop release asset verification", () => {
  test("requires Linux arm64 updater metadata in the draft", () => {
    const version = "1.2.3"
    const names = new Set([...expectedDesktopChecksumAssetNames(version), desktopChecksumsName(version)])
    names.delete("latest-linux-arm64.yml")

    expect(() => assertDesktopAssetNames(version, names)).toThrow(
      /missing desktop updater metadata latest-linux-arm64\.yml/,
    )
  })

  test("accepts matching checksums and legitimate uploaded extras", () => {
    const expectedNames = ["Synergy-win32-x64-1.2.3.exe", "latest-linux-arm64.yml"]
    const hashes = new Map(expectedNames.map((name) => [name, checksum(name)]))
    const uploaded = new Set([...expectedNames, "builder-debug.yml"])
    const manifest = [
      ...expectedNames.map((name) => `${checksum(name)}  ${name}`),
      `${checksum("debug")}  builder-debug.yml`,
      "",
    ].join("\n")

    expect(() => assertDesktopAssetChecksums(manifest, hashes, expectedNames, uploaded)).not.toThrow()
  })

  test.each([
    ["malformed line", "invalid", /invalid desktop checksum line/],
    [
      "duplicate entry",
      `${checksum("asset")}  asset.exe\n${checksum("asset")}  asset.exe\n`,
      /duplicate desktop checksum/,
    ],
    ["missing entry", "", /missing desktop checksum/],
  ])("rejects a %s", (_scenario, manifest, expected) => {
    const hashes = new Map([["asset.exe", checksum("asset")]])
    expect(() => assertDesktopAssetChecksums(manifest, hashes, ["asset.exe"])).toThrow(expected)
  })

  test("rejects checksum mismatches and entries outside the uploaded release", () => {
    const hashes = new Map([["asset.exe", checksum("actual")]])
    expect(() => assertDesktopAssetChecksums(`${checksum("expected")}  asset.exe\n`, hashes, ["asset.exe"])).toThrow(
      /desktop checksum mismatch/,
    )
    expect(() =>
      assertDesktopAssetChecksums(
        `${checksum("actual")}  asset.exe\n${checksum("stale")}  stale.exe\n`,
        hashes,
        ["asset.exe"],
        new Set(["asset.exe"]),
      ),
    ).toThrow(/unexpected desktop checksum for stale\.exe/)
  })

  test("downloads and verifies every expected Desktop release asset", async () => {
    const state = releaseState()
    const expectedNames = expectedDesktopChecksumAssetNames(state.version)
    const checksumName = desktopChecksumsName(state.version)
    const downloaded: string[] = []
    const manifest = `${expectedNames.map((name) => `${checksum(name)}  ${name}`).join("\n")}\n`
    const download = async (_tag: string, assetName: string, outputPath: string) => {
      downloaded.push(assetName)
      await fs.writeFile(outputPath, assetName === checksumName ? manifest : assetName)
    }

    await verifyPublishedDesktopChecksums(state, download, new Set([...expectedNames, checksumName]))

    expect(downloaded).toContain(checksumName)
    expect(downloaded).toContain("latest-linux-arm64.yml")
    expect(downloaded).toHaveLength(expectedNames.length + 1)
    expect(downloaded.every((assetName) => path.basename(assetName) === assetName)).toBe(true)
  })
})
