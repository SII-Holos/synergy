import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorktreeProcess } from "../../src/workspace/process"
import { WorktreeRelocation } from "../../src/workspace/relocation"
import { testRuntime } from "../support/runtime"

test("copied Git Workspaces repair all links while preserving source and foreign repositories", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using source = await tmpdir({ git: true })
    await using target = await tmpdir()
    await using foreign = await tmpdir({ git: true })
    const linked = path.join(source.path, "linked")
    await ScopeContext.provide({
      scope: await source.scope(),
      async fn() {
        const added = await WorktreeProcess.run({
          command: ["git", "worktree", "add", "-b", "linked", linked],
          directory: source.path,
          roots: [source.path],
          metadata: true,
        })
        expect(added.exitCode).toBe(0)
        const sourcePointer = await Bun.file(path.join(linked, ".git")).text()
        const sourceBacklink = await Bun.file(path.join(source.path, ".git/worktrees/linked/gitdir")).text()
        await fs.cp(source.path, target.path, { recursive: true })
        const copiedPointer = path.join(target.path, "linked/.git")
        const foreignPointer = `gitdir: ${path.join(foreign.path, ".git")}\n`
        await Bun.write(copiedPointer, foreignPointer)
        const input = { sourceRoot: source.path, targetRoot: target.path, directories: [source.path, linked] }
        await expect(WorktreeRelocation.repairCopied(input)).rejects.toThrow("another repository")
        expect(await Bun.file(copiedPointer).text()).toBe(foreignPointer)
        expect(await Bun.file(path.join(source.path, ".git/worktrees/linked/gitdir")).text()).toBe(sourceBacklink)
        await Bun.write(copiedPointer, sourcePointer)
        await WorktreeRelocation.repairCopied(input)
        expect(await Bun.file(copiedPointer).text()).toBe(
          `gitdir: ${path.join(target.path, ".git/worktrees/linked")}\n`,
        )
        expect(await Bun.file(path.join(linked, ".git")).text()).toBe(sourcePointer)
        expect(await Bun.file(path.join(source.path, ".git/worktrees/linked/gitdir")).text()).toBe(sourceBacklink)
        const targetScope = await target.scope()
        await fs.rm(source.path, { recursive: true })
        await ScopeContext.provide({
          scope: targetScope,
          async fn() {
            const copied = path.join(target.path, "linked")
            const resolved = await WorktreeProcess.run({
              command: ["git", "rev-parse", "--git-common-dir"],
              directory: copied,
              roots: [],
              metadata: true,
            })
            expect(resolved.exitCode).toBe(0)
            expect(path.resolve(copied, resolved.stdout.toString("utf8").trim())).toBe(path.join(target.path, ".git"))
          },
        })
      },
    })
  })
}, 20000)
