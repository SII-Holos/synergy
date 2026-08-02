import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  assertBinaryAssetChecksums,
  assertDraftAssetNames,
  verifyPublishedBinaryChecksums,
} from "../../../script/release/nodes/verify-draft-assets"
import type { ReleaseState } from "../../../script/release/shared/packages"

function createState(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    kind: "stable",
    version: "1.2.3",
    channel: "latest",
    promoteTag: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    registryPackages: [],
    binaryAssets: ["/release/synergy-linux-x64.tar.gz"],
    binaryChecksums: "/release/Synergy-1.2.3-cli-checksums.txt",
    desktopAssets: ["/release/Synergy-1.2.3.dmg"],
    desktopChecksums: "/release/Synergy-1.2.3-checksums.txt",
    desktopUpdateMetadata: ["latest-mac.yml"],
    releaseTag: "v1.2.3",
    githubReleaseID: null,
    githubReleaseTagName: null,
    ...overrides,
  }
}

const completeAssets = [
  "synergy-linux-x64.tar.gz",
  "Synergy-1.2.3-cli-checksums.txt",
  "Synergy-1.2.3.dmg",
  "Synergy-1.2.3-checksums.txt",
  "latest-mac.yml",
]

function checksum(contents: string) {
  return createHash("sha256").update(contents).digest("hex")
}

describe("draft release asset verification", () => {
  test("accepts a draft containing every binary and Desktop release asset", () => {
    expect(() => assertDraftAssetNames(createState(), completeAssets)).not.toThrow()
  })

  test("rejects a draft missing the CLI archive checksum asset", () => {
    expect(() =>
      assertDraftAssetNames(
        createState(),
        completeAssets.filter((name) => name !== "Synergy-1.2.3-cli-checksums.txt"),
      ),
    ).toThrow(/missing draft release CLI checksum Synergy-1\.2\.3-cli-checksums\.txt/)
  })

  test("accepts checksums matching every downloaded CLI archive", () => {
    const assets = new Map([
      ["synergy-linux-x64.tar.gz", checksum("linux")],
      ["synergy-windows-x64.zip", checksum("windows")],
    ])
    const manifest = [
      `${checksum("linux")}  synergy-linux-x64.tar.gz`,
      `${checksum("windows")}  synergy-windows-x64.zip`,
      "",
    ].join("\n")

    expect(() => assertBinaryAssetChecksums(manifest, assets)).not.toThrow()
  })

  test("downloads and validates the published CLI runtime archive before accepting the draft", async () => {
    const archiveName = "synergy-linux-x64.tar.gz"
    const checksumName = "Synergy-1.2.3-cli-checksums.txt"
    const downloaded: string[] = []
    const validated: Array<{ archive: string; target: string }> = []
    const download = async (_tag: string, assetName: string, outputPath: string) => {
      downloaded.push(assetName)
      const contents =
        assetName === checksumName ? `${checksum("published archive")}  ${archiveName}\n` : "published archive"
      await fs.writeFile(outputPath, contents)
    }
    const validate = async (archive: string, target: string) => {
      validated.push({ archive: path.basename(archive), target })
    }

    await verifyPublishedBinaryChecksums(createState({ desktopAssets: [], desktopChecksums: null }), download, validate)

    expect(downloaded).toEqual([checksumName, archiveName])
    expect(downloaded.every((assetName) => path.basename(assetName) === assetName)).toBe(true)
    expect(validated).toEqual([{ archive: archiveName, target: "synergy-linux-x64" }])
  })

  test("rejects a published CLI runtime archive whose contents fail validation", async () => {
    const archiveName = "synergy-linux-x64.tar.gz"
    const checksumName = "Synergy-1.2.3-cli-checksums.txt"
    const download = async (_tag: string, assetName: string, outputPath: string) => {
      const contents = assetName === checksumName ? `${checksum("archive")}  ${archiveName}\n` : "archive"
      await fs.writeFile(outputPath, contents)
    }

    await expect(
      verifyPublishedBinaryChecksums(createState({ desktopAssets: [], desktopChecksums: null }), download, async () => {
        throw new Error("runtime manifest is missing")
      }),
    ).rejects.toThrow(/runtime manifest is missing/)
  })

  test("rejects a CLI checksum manifest missing an archive", () => {
    const assets = new Map([
      ["synergy-linux-x64.tar.gz", checksum("linux")],
      ["synergy-windows-x64.zip", checksum("windows")],
    ])

    expect(() => assertBinaryAssetChecksums(`${checksum("linux")}  synergy-linux-x64.tar.gz\n`, assets)).toThrow(
      /missing CLI checksum for synergy-windows-x64\.zip/,
    )
  })

  test("rejects a downloaded CLI archive that does not match its checksum", () => {
    const assets = new Map([["synergy-linux-x64.tar.gz", checksum("tampered")]])

    expect(() => assertBinaryAssetChecksums(`${checksum("original")}  synergy-linux-x64.tar.gz\n`, assets)).toThrow(
      /CLI checksum mismatch for synergy-linux-x64\.tar\.gz/,
    )
  })

  test.each([
    ["single-space separator", `${checksum("linux")} synergy-linux-x64.tar.gz\n`],
    ["relative path", `${checksum("linux")}  ../synergy-linux-x64.tar.gz\n`],
    ["trailing field", `${checksum("linux")}  synergy-linux-x64.tar.gz trailing\n`],
  ])("rejects an invalid CLI checksum line with a %s", (_scenario, manifest) => {
    const assets = new Map([["synergy-linux-x64.tar.gz", checksum("linux")]])

    expect(() => assertBinaryAssetChecksums(manifest, assets)).toThrow(/invalid CLI checksum line/)
  })

  test("rejects checksum entries for assets outside the release state", () => {
    const assets = new Map([["synergy-linux-x64.tar.gz", checksum("linux")]])
    const manifest = [`${checksum("linux")}  synergy-linux-x64.tar.gz`, `${checksum("stale")}  stale.tar.gz`, ""].join(
      "\n",
    )

    expect(() => assertBinaryAssetChecksums(manifest, assets)).toThrow(/unexpected CLI checksum for stale\.tar\.gz/)
  })
})
