import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { Worktree } from "../../src/project/worktree"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("git worktree integration", () => {
  test("parses git worktree porcelain output", () => {
    const entries = Worktree.parsePorcelain(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/dev",
        "",
        "worktree /repo/.synergy/worktrees/feature",
        "HEAD def456",
        "detached",
        "",
      ].join("\n"),
    )

    expect(entries).toEqual([
      { path: "/repo", head: "abc123", branch: "dev" },
      { path: "/repo/.synergy/worktrees/feature", head: "def456", detached: true },
    ])
  })

  test("lists main worktree from git as an external main workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const items = await Worktree.list()
          expect(items.some((item) => item.isMain && item.path === scope.worktree)).toBe(true)
          const main = items.find((item) => item.isMain)
          expect(main?.managed).toBe(false)
          expect(main?.owner?.type).toBe("external")
        })(),
    })
  })

  test("creates a managed worktree under .synergy/worktrees and binds the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, ".env.local"), "TOKEN=local")
    await fs.mkdir(path.join(tmp.path, ".synergy"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, ".synergy", "worktree-setup.jsonc"),
      JSON.stringify({ copyIgnored: [".env.local"], setup: ["printf setup > setup.txt"] }),
    )
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Worktree Test" })
          const created = await Worktree.create({
            name: "feature one",
            sessionID: session.id,
            bind: true,
            baseRef: "current",
          })

          expect(created.managed).toBe(true)
          expect(created.path).toStartWith(path.join(scope.worktree, ".synergy", "worktrees"))
          expect(await Bun.file(path.join(created.path, ".env.local")).text()).toBe("TOKEN=local")
          expect(await Bun.file(path.join(created.path, "setup.txt")).text()).toBe("setup")

          const updated = await Session.get(session.id)
          expect(updated.workspace?.type).toBe("git_worktree")
          expect(updated.workspace?.path).toBe(created.path)
          expect(updated.workspace?.worktreeID).toBe(created.id)

          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed?.bindings).toContain(session.id)
          expect(managed?.owner?.type).toBe("session")

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("enter and leave mutate only session workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Enter Leave" })
          const created = await Worktree.create({ name: "switch target", bind: false, baseRef: "current" })

          await Worktree.enter({ sessionID: session.id, target: created.name, force: false })
          let current = await Session.get(session.id)
          expect(current.workspace?.type).toBe("git_worktree")
          expect(current.workspace?.path).toBe(created.path)
          expect((current.scope as typeof scope).id).toBe(scope.id)

          await Worktree.leave(session.id)
          current = await Session.get(session.id)
          expect(current.workspace?.type).toBe("main")
          expect(current.workspace?.path).toBe(scope.directory)
          expect((current.scope as typeof scope).id).toBe(scope.id)

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("throws a clear error for non-git scopes", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          await expect(Worktree.list()).rejects.toThrow("git worktree is unavailable")
        })(),
    })
  })
})

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}
