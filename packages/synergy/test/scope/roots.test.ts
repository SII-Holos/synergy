import { describe, expect, test } from "bun:test"
import path from "path"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function projectScope(input: { worktree: string; sandboxes?: string[] }): Scope {
  return {
    type: "project",
    id: "d_test",
    directory: input.worktree,
    worktree: input.worktree,
    vcs: "git",
    sandboxes: input.sandboxes ?? [],
    time: { created: 0, updated: 0 },
  }
}

describe("Scope.Root.projectRoots", () => {
  test("home scope has no project roots", () => {
    const home = Scope.home()
    expect(Scope.Root.projectRoots(home)).toEqual([])
  })

  test("derives worktree + sandboxes as project roots", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder")
    await $`mkdir -p ${folder}`.quiet()

    const roots = Scope.Root.projectRoots(projectScope({ worktree: tmp.path, sandboxes: [folder] }))
    expect(roots).toEqual([tmp.path, folder])
  })

  test("deduplicates and filters non-existent sandboxes", async () => {
    await using tmp = await tmpdir()
    const missing = path.join(tmp.path, "missing")

    const roots = Scope.Root.projectRoots(
      projectScope({ worktree: tmp.path, sandboxes: [tmp.path, missing, path.join(tmp.path, "nested")] }),
    )
    expect(roots).toEqual([tmp.path])
  })

  test("empty sandboxes yields just the worktree", async () => {
    await using tmp = await tmpdir()
    expect(Scope.Root.projectRoots(projectScope({ worktree: tmp.path }))).toEqual([tmp.path])
  })
})

describe("Scope.Root.trustRoots", () => {
  test("main workspace keeps all project roots", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder")
    await $`mkdir -p ${folder}`.quiet()

    const roots = Scope.Root.trustRoots(projectScope({ worktree: tmp.path, sandboxes: [folder] }), {
      type: "main",
      path: tmp.path,
      scopeID: "d_test",
    })
    expect(roots).toEqual([tmp.path, folder])
  })

  test("git_worktree session excludes the original checkout but keeps sibling folders", async () => {
    await using tmp = await tmpdir()
    await using sibling = await tmpdir()

    const scope = projectScope({ worktree: tmp.path, sandboxes: [sibling.path] })
    const roots = Scope.Root.trustRoots(scope, {
      type: "git_worktree",
      path: sibling.path,
      scopeID: "d_test",
      originalCheckout: tmp.path,
    })
    expect(roots).toEqual([sibling.path])
    expect(roots).not.toContain(tmp.path)
  })

  test("git_worktree without originalCheckout excludes the main worktree", async () => {
    await using tmp = await tmpdir()
    await using sibling = await tmpdir()

    const roots = Scope.Root.trustRoots(projectScope({ worktree: tmp.path, sandboxes: [sibling.path] }), {
      type: "git_worktree",
      path: sibling.path,
      scopeID: "d_test",
    })
    // Without explicit originalCheckout metadata the persisted main worktree
    // is the implicit original checkout and stays outside the trust boundary.
    expect(roots).toEqual([sibling.path])
  })

  test("git_worktree session excludes sandbox folders nested inside the original checkout", async () => {
    await using tmp = await tmpdir()
    const nested = path.join(tmp.path, "nested-folder")
    await $`mkdir -p ${nested}`.quiet()

    // A subdirectory previously opened inside the main checkout is recorded
    // into `sandboxes`. It must NOT become trusted inside an isolated worktree
    // session — that would bypass worktree isolation with write access into
    // the original checkout.
    const scope = projectScope({ worktree: tmp.path, sandboxes: [nested] })
    const roots = Scope.Root.trustRoots(scope, {
      type: "git_worktree",
      path: path.join(tmp.path, ".synergy", "worktrees", "feature-x"),
      scopeID: "d_test",
      originalCheckout: tmp.path,
    })
    expect(roots).not.toContain(tmp.path)
    expect(roots).not.toContain(nested)
  })

  test("no workspace keeps all roots", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder")
    await $`mkdir -p ${folder}`.quiet()

    const roots = Scope.Root.trustRoots(projectScope({ worktree: tmp.path, sandboxes: [folder] }))
    expect(roots).toEqual([tmp.path, folder])
  })
})

describe("Scope.contains home fallback", () => {
  test("home scope keeps legacy single-directory containment", () => {
    const home = Scope.home()
    expect(Scope.contains(home, home.directory)).toBe(true)
    expect(Scope.contains(home, path.join(home.directory, "Documents", "notes.txt"))).toBe(true)
    expect(Scope.contains(home, "/definitely-not-home-xyz")).toBe(false)
  })
})

describe("Scope.contains with multiple roots", () => {
  test("target inside an additional sandbox folder is contained", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder")
    await $`mkdir -p ${folder}`.quiet()

    const scope = projectScope({ worktree: tmp.path, sandboxes: [folder] })
    expect(Scope.contains(scope, path.join(folder, "file.txt"))).toBe(true)
    expect(Scope.contains(scope, path.join(tmp.path, "other.txt"))).toBe(true)
    expect(Scope.contains(scope, path.join(path.dirname(tmp.path), "outside.txt"))).toBe(false)
  })
})
