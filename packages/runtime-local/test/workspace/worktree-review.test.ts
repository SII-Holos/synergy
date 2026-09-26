import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "../../src/workspace/worktree"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function fixture(action: (root: string) => Promise<void>, published = true) {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      if (published) await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
      await action(scope.local!.worktree)
    },
  })
}

test("explicit removal keeps anonymous active users", () =>
  runtime.run(async () => {
    await fixture(async () => {
      const tree = await Worktree.create({ name: "anonymous-use", bind: false, baseRef: "current" })
      await Worktree.withUse(tree.path, undefined, async () => {
        await expect(Worktree.remove({ target: tree.id })).rejects.toThrow("in use")
        expect(await Bun.file(path.join(tree.path, ".git")).exists()).toBe(true)
      })
    })
  }))

test("the managed cap cannot delete an actively reserved worktree", () =>
  runtime.run(async () => {
    await fixture(async () => {
      const tree = await Worktree.create({ name: "active-cap", bind: false, baseRef: "current" })
      await Worktree.withUse(tree.path, "active-owner", async () => {
        const report = await Worktree.sweep({ maxManaged: 0 })
        expect(report.removed).toEqual([])
        expect(await Bun.file(path.join(tree.path, ".git")).exists()).toBe(true)
      })
    })
  }))

test("a repository without remote refs keeps its local-only commits", () =>
  runtime.run(async () => {
    await fixture(async () => {
      const tree = await Worktree.create({ name: "local-only", bind: false, baseRef: "current" })
      await $`git commit --allow-empty -qm local-only`.quiet().cwd(tree.path)
      const report = await Worktree.sweep({ maxManaged: 0 })
      expect(report.removed).toEqual([])
      expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "local_only_commits" })
    }, false)
  }))

test("stale reconciliation preserves a locked missing managed worktree", () =>
  runtime.run(async () => {
    await fixture(async (root) => {
      const tree = await Worktree.create({ name: "missing-locked", bind: false, baseRef: "current" })
      await $`git worktree lock --reason offline-volume ${tree.path}`.quiet().cwd(root)
      await fs.rm(tree.path, { recursive: true, force: true })
      const report = await Worktree.sweep()
      expect(report.reconciled).toEqual([])
      expect(await Bun.file(path.join(root, ".synergy/worktrees/.registry", `${tree.id}.json`)).exists()).toBe(true)
      expect(await $`git worktree list --porcelain`.quiet().cwd(root).text()).toContain("offline-volume")
    })
  }))

test("a sweep never prunes missing external worktrees", () =>
  runtime.run(async () => {
    await fixture(async (root) => {
      const directory = path.join(root, "external-checkout")
      await $`git worktree add --detach ${directory} HEAD`.quiet().cwd(root)
      await fs.rm(directory, { recursive: true, force: true })
      await Worktree.sweep()
      expect(await $`git worktree list --porcelain`.quiet().cwd(root).text()).toContain("external-checkout")
    })
  }))

test("reclaiming an idle bound worktree migrates the session to the main checkout", () =>
  runtime.run(async () => {
    await fixture(async () => {
      const session = await Session.create({})
      try {
        const tree = await Worktree.create({
          name: "idle-binding",
          sessionID: session.id,
          bind: true,
          baseRef: "current",
        })
        const report = await Worktree.sweep({ maxManaged: 0 })
        expect(report.removed).toContain(tree.id)
        expect((await Session.get(session.id)).workspace?.type).not.toBe("git_worktree")
      } finally {
        await Session.remove(session.id)
      }
    })
  }))

test("a Synergy marker alone does not prove another process released its lock", () =>
  runtime.run(async () => {
    await fixture(async (root) => {
      const tree = await Worktree.create({ name: "other-process", bind: false, baseRef: "current" })
      await $`git worktree lock --reason synergy:v1:session=another-process ${tree.path}`.quiet().cwd(root)
      const report = await Worktree.sweep({ maxManaged: 0 })
      expect(report.removed).toEqual([])
      expect(await $`git worktree list --porcelain`.quiet().cwd(root).text()).toContain("another-process")
    })
  }))

test("unlock preserves a user lock that replaced the runtime's earlier lock", () =>
  runtime.run(async () => {
    await fixture(async (root) => {
      const tree = await Worktree.create({ name: "replaced-lock", bind: false, baseRef: "current" })
      await Worktree.lock(tree.path)
      await $`git worktree unlock ${tree.path}`.quiet().cwd(root)
      await $`git worktree lock --reason user-replaced ${tree.path}`.quiet().cwd(root)
      await Worktree.unlock(tree.path)
      expect(await $`git worktree list --porcelain`.quiet().cwd(root).text()).toContain("user-replaced")
    })
  }))

test("branch cleanup keeps changes introduced only by an unlanded merge commit", () =>
  runtime.run(async () => {
    await fixture(async (root) => {
      const tree = await Worktree.create({ name: "merge-only", bind: false, baseRef: "current" })
      const sideBranch = "side-input"
      await $`git branch ${sideBranch} HEAD`.quiet().cwd(root)
      await Bun.write(path.join(tree.path, "topic.txt"), "topic")
      await $`git add topic.txt`.quiet().cwd(tree.path)
      await $`git commit -qm topic-change`.quiet().cwd(tree.path)
      const topic = (await $`git rev-parse HEAD`.quiet().cwd(tree.path).text()).trim()
      const side = path.join(root, "side-checkout")
      await $`git worktree add ${side} ${sideBranch}`.quiet().cwd(root)
      await Bun.write(path.join(side, "side.txt"), "side")
      await $`git add side.txt`.quiet().cwd(side)
      await $`git commit -qm side-change`.quiet().cwd(side)
      await $`git cherry-pick --no-commit ${topic}`.quiet().cwd(root)
      await $`git commit -qm landed-topic`.quiet().cwd(root)
      await $`git cherry-pick --no-commit ${sideBranch}`.quiet().cwd(root)
      await $`git commit -qm landed-side`.quiet().cwd(root)
      await $`git merge --no-ff --no-commit ${sideBranch}`.quiet().cwd(tree.path)
      await Bun.write(path.join(tree.path, "merge-only.txt"), "unlanded merge resolution")
      await $`git add merge-only.txt`.quiet().cwd(tree.path)
      await $`git commit -qm merge-with-resolution`.quiet().cwd(tree.path)
      await Worktree.remove({ target: tree.id })
      expect(
        (await $`git show-ref --verify --quiet refs/heads/${tree.branch}`.quiet().nothrow().cwd(root)).exitCode,
      ).toBe(0)
    })
  }))

afterRuntimeTests(() => runtime.close())
