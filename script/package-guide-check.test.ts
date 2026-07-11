import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validatePackageGuides } from "./package-guide-check"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace package guide validation", () => {
  test("requires a non-empty AGENTS.md in every configured workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-package-guide-"))
    roots.push(root)
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/one", "packages/two"] } }),
    )
    await Promise.all([
      mkdir(path.join(root, "packages/one"), { recursive: true }),
      mkdir(path.join(root, "packages/two"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(root, "packages/one/package.json"), "{}"),
      writeFile(path.join(root, "packages/two/package.json"), "{}"),
      writeFile(path.join(root, "packages/one/AGENTS.md"), "# One\n"),
    ])

    expect(await validatePackageGuides(root)).toEqual(["packages/two: missing or empty AGENTS.md"])
  })
})
