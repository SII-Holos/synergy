// ---------------------------------------------------------------------------
// sandbox/linux-multi-root.test.ts
//
// Multi-root project folders on the Linux helper-backed sandbox:
// the permission profile JSON written for the Rust helper must aggregate the
// enforcement gate's protected paths — including `<additionalRoot>/.git` for
// every writable project root — so git metadata under additional project
// folders stays read-only inside bwrap.
//
// Non-existent protected paths must be filtered out: bwrap hard-fails when a
// --ro-bind source is missing, and the helper's ProtectedCreateMonitor covers
// the create-new-metadata vector for paths that do not exist yet.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/linux-multi-root.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

function prepareLinuxMultiRoot(input: { workspace: string; extraRoots: string[]; protectedPaths?: string[] }) {
  return SandboxBackend.prepareWrapper({
    command: "echo",
    args: ["hello"],
    workspace: input.workspace,
    sandboxMode: "workspace_write",
    forcePlatform: "linux",
    forceHelperPath: "/test/synergy-sandbox-linux",
    forceHelperVerified: true,
    extraWritableRoots: input.extraRoots,
    protectedPaths: input.protectedPaths,
  })
}

describe("Linux helper profile multi-root protected paths", () => {
  test("aggregates gate protected paths including additional-root .git", async () => {
    await using tmp = await tmpdir({ git: true })
    const folderA = path.join(tmp.path, "folder-a")
    await $`mkdir -p ${path.join(folderA, ".git")}`.quiet()
    const folderAGit = path.join(folderA, ".git")

    const wrapper = prepareLinuxMultiRoot({
      workspace: tmp.path,
      extraRoots: [folderA],
      protectedPaths: [path.join(tmp.path, ".git"), folderAGit],
    })

    expect(wrapper.sandboxed).toBe(true)
    const profile = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))

    // Every existing protected path — including the additional root's .git —
    // lands in protectedPaths and readOnlySubpaths of the helper profile.
    expect(profile.fileSystem.protectedPaths).toContain(path.join(tmp.path, ".git"))
    expect(profile.fileSystem.protectedPaths).toContain(folderAGit)
    expect(profile.fileSystem.readOnlySubpaths).toContain(folderAGit)

    // The additional root is writable (bind), but its .git stays read-only.
    expect(profile.fileSystem.writableRoots).toContain(folderA)

    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("filters non-existent protected paths so bwrap does not hard-fail", async () => {
    await using tmp = await tmpdir()
    const folderA = path.join(tmp.path, "folder-a")
    await $`mkdir -p ${folderA}`.quiet()
    // .git does NOT exist under folderA.
    const missingGit = path.join(folderA, ".git")

    const wrapper = prepareLinuxMultiRoot({
      workspace: tmp.path,
      extraRoots: [folderA],
      protectedPaths: [missingGit],
    })

    expect(wrapper.sandboxed).toBe(true)
    const profile = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))

    expect(profile.fileSystem.protectedPaths).not.toContain(missingGit)
    expect(profile.fileSystem.readOnlySubpaths).not.toContain(missingGit)
    // The writable root itself is still present.
    expect(profile.fileSystem.writableRoots).toContain(folderA)

    fs.rmSync(wrapper.tempPath!, { force: true })
  })
})
