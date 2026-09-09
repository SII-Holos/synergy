import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sourceFiles } from "../../script/secrets-check"

test("source scan includes moved and new source while excluding ignored builds and external symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-scan-fixture-"))
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    await Bun.write(path.join(root, ".gitignore"), "dist/\n")
    await Bun.write(path.join(root, "old.ts"), "export const value = 1\n")
    execFileSync("git", ["add", ".gitignore", "old.ts"], { cwd: root })
    await rm(path.join(root, "old.ts"))
    await Bun.write(path.join(root, "packages/domain/src/new.ts"), "export const value = 1\n")
    await Bun.write(path.join(root, "dist/generated.js"), "generated output\n")
    await symlink(os.tmpdir(), path.join(root, "external"))
    expect(await sourceFiles(root)).toEqual([".gitignore", "packages/domain/src/new.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
