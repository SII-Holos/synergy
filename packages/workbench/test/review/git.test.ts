import { expect, test } from "bun:test"
import path from "node:path"
import { rm, symlink } from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "../support/runtime"
import { ReviewGit } from "../../src/review/git"

test("worktree review includes staged, unstaged and untracked paths and fences changes", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await Bun.write(path.join(directory.path, "tracked.txt"), "before\n")
    await Bun.write(path.join(directory.path, "deleted.txt"), "remove\n")
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: directory.path, stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(0)
    }
    await git("add", ".")
    await git("commit", "-m", "fixture")
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const workspace = ScopeContext.current.workspace!
        const input = { source: "worktree" as const, workspaceID: workspace.id!, generation: workspace.generation! }
        await Bun.write(path.join(directory.path, "tracked.txt"), "after\n")
        await git("add", "tracked.txt")
        await Bun.write(path.join(directory.path, "line\nbreak.txt"), "new\n")
        await rm(path.join(directory.path, "deleted.txt"))
        await symlink("/outside-workspace", path.join(directory.path, "link.txt"))
        const result = await ReviewGit.compare(input)
        expect(result.files.map((file) => file.file).sort()).toEqual([
          "deleted.txt",
          "line\nbreak.txt",
          "link.txt",
          "tracked.txt",
        ])
        expect(result.files.find((file) => file.file === "deleted.txt")?.status).toBe("deleted")
        expect(result.files.find((file) => file.file === "line\nbreak.txt")?.status).toBe("added")
        expect(result.files.find((file) => file.file === "tracked.txt")?.status).toBe("modified")
        const link = result.files.find((file) => file.file === "link.txt")!
        expect((await ReviewGit.file({ ...input, file: link.file, version: link.version })).after.kind).toBe("symlink")
        const file = result.files.find((file) => file.file === "tracked.txt")!
        const content = await ReviewGit.file({ ...input, file: file.file, version: file.version })
        expect(content.before.content).toBe("before\n")
        expect(content.after.content).toBe("after\n")
        const special = result.files.find((file) => file.file === "line\nbreak.txt")!
        expect((await ReviewGit.file({ ...input, file: special.file, version: special.version })).after.content).toBe(
          "new\n",
        )
        await Bun.write(path.join(directory.path, "tracked.txt"), "later\n")
        await expect(ReviewGit.file({ ...input, file: file.file, version: file.version })).rejects.toMatchObject({
          name: "ReviewConflict",
        })
        await expect(ReviewGit.compare({ ...input, generation: input.generation + 1 })).rejects.toThrow()
        await expect(ReviewGit.file({ ...input, file: "../outside", version: "x" })).rejects.toThrow()
      },
    })
  })
})

test("branch review resolves immutable refs and rejects option injection", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const workspace = ScopeContext.current.workspace!
        const input = {
          source: "branch" as const,
          workspaceID: workspace.id!,
          generation: workspace.generation!,
          from: "HEAD",
          to: "HEAD",
        }
        expect((await ReviewGit.compare(input)).files).toEqual([])
        await expect(ReviewGit.compare({ ...input, from: "--help" })).rejects.toThrow()
      },
    })
  })
})
