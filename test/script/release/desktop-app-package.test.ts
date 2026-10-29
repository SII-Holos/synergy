import { expect, test } from "bun:test"
import {
  createDesktopAppPackage,
  desktopApplicationArtifacts,
  assertDesktopUpgradeReceipt,
} from "../../../script/release/shared/desktop-app-package"

const version = "4.1.0"
const repository = "example/synergy"
function receipts() {
  return ["darwin", "win32", "linux"].map((platform) => ({
    version,
    artifacts: desktopApplicationArtifacts(version, platform).map((item) => ({
      ...item.artifact,
      url: `https://github.com/${repository}/releases/download/v${version}/${item.file}`,
      sha256: "a".repeat(64),
      signing: platform === "darwin" ? { type: "apple", teamID: "ABCDEFGHIJ" } : { type: "checksum" },
    })),
  }))
}

test("Desktop package selects five supported portable applications with verified release identities", () => {
  const manifest = createDesktopAppPackage({ version, repository, receipts: receipts() })
  expect(manifest.name).toBe("@ericsanchezok/synergy-desktop-app")
  expect(manifest.synergy.kind).toBe("app")
  if (manifest.synergy.kind !== "app") throw new Error("Expected an application")
  expect(manifest.synergy.artifacts).toHaveLength(5)
  expect(manifest.synergy.artifacts.some((item) => item.target === "win32-arm64")).toBe(false)
  expect(manifest.synergy.artifacts.find((item) => item.target === "linux-x64")?.url).toEndWith(
    "Synergy-linux-x86_64-4.1.0.AppImage",
  )
})

test("final-artifact upgrade evidence must match the release, baseline and uploaded bytes", () => {
  const artifact = `Synergy-darwin-arm64-${version}.zip`
  const sha256 = "a".repeat(64)
  const receipt = { version, previousVersion: "3.0.22", target: "darwin-arm64", artifact, sha256 }
  const hashes = new Map([[artifact, sha256]])
  expect(() => assertDesktopUpgradeReceipt(receipt, version, hashes)).not.toThrow()
  for (const changed of [
    undefined,
    { ...receipt, version: "4.2.0" },
    { ...receipt, previousVersion: "3.0.21" },
    { ...receipt, target: "darwin-x64" },
    { ...receipt, artifact: "replacement.zip" },
    { ...receipt, sha256: "b".repeat(64) },
  ])
    expect(() => assertDesktopUpgradeReceipt(changed, version, hashes)).toThrow()
  expect(() => assertDesktopUpgradeReceipt(receipt, version, new Map())).toThrow("differs")
})

test("Desktop publication rejects missing, duplicate, stale or redirected artifact receipts", () => {
  const input = { version, repository, receipts: receipts() }
  expect(() => createDesktopAppPackage({ ...input, receipts: input.receipts.slice(1) })).toThrow("Missing")
  expect(() => createDesktopAppPackage({ ...input, receipts: [...input.receipts, input.receipts[0]] })).toThrow(
    "Duplicate",
  )
  expect(() => createDesktopAppPackage({ ...input, version: "4.2.0" })).toThrow("version")
  input.receipts[0]!.artifacts[0]!.url = "https://example.com/redirected.zip"
  expect(() => createDesktopAppPackage(input)).toThrow("identity")
})
