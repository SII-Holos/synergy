import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stageOrganizationImage } from "../../script/organization-image"
import type { PackedArchive } from "../../script/package-install-check"
import { nativePackageName } from "../../packages/util/src/native-assets"

test("organization image staging rejects an incomplete platform closure before installing or writing output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-org-image-test-"))
  try {
    const output = path.join(root, "context")
    await expect(stageOrganizationImage({ archives: [], destination: output, arch: "x64" })).rejects.toThrow(
      "Missing organization image archive",
    )
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("organization image staging rejects mixed release versions and preserves an existing destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-org-image-test-"))
  const archives: PackedArchive[] = [
    "@ericsanchezok/synergy-organization",
    "@ericsanchezok/synergy-cli",
    nativePackageName({ platform: "linux", arch: "x64", libc: "glibc" }),
  ].map((name) => ({
    name,
    version: "1.0.0",
    archive: path.join(root, `${name.replaceAll("/", "-")}.tgz`),
    manifest: {},
  }))
  try {
    await expect(
      stageOrganizationImage({
        archives: archives.map((archive, index) => ({ ...archive, version: index ? "1.0.1" : "1.0.0" })),
        destination: path.join(root, "context"),
        arch: "x64",
      }),
    ).rejects.toThrow("one release version")
    await expect(stageOrganizationImage({ archives, destination: root, arch: "x64" })).rejects.toThrow("must not exist")
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
