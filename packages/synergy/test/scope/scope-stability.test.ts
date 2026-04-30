import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Scope ID stability", () => {
  test("scope ID does not change when git init is added to an existing project", async () => {
    // 1. Open a directory without git — gets a dir-hash scope
    await using tmp = await tmpdir()
    const before = await Scope.fromDirectory(tmp.path)
    expect(before.scope.id).toStartWith("d_")
    const stableID = before.scope.id

    // 2. git init (no commits) — scope ID must not change
    await $`git init`.cwd(tmp.path).quiet()
    const afterInit = await Scope.fromDirectory(tmp.path)
    expect(afterInit.scope.id).toBe(stableID)
    expect(afterInit.scope.type === "project" && afterInit.scope.vcs).toBe("git")

    // 3. Make a commit — scope ID must still not change
    await $`git config user.email test@synergy.dev`.cwd(tmp.path).quiet()
    await $`git config user.name "Test Agent"`.cwd(tmp.path).quiet()
    await $`git commit --allow-empty -m "root commit"`.cwd(tmp.path).quiet()
    const afterCommit = await Scope.fromDirectory(tmp.path)
    expect(afterCommit.scope.id).toBe(stableID)
    expect(afterCommit.scope.type === "project" && afterCommit.scope.vcs).toBe("git")

    // 4. Subsequent calls are stable (cached in .git/synergy)
    const again = await Scope.fromDirectory(tmp.path)
    expect(again.scope.id).toBe(stableID)
  })

  test("fresh git repo still gets a commit-based scope ID", async () => {
    // A directory opened for the first time as a git repo with commits
    // should get the git root commit as its scope ID (no prior dir-hash to preserve)
    await using tmp = await tmpdir({ git: true })
    const result = await Scope.fromDirectory(tmp.path)
    expect(result.scope.id).not.toStartWith("d_")
    if (result.scope.type === "project") {
      expect(result.scope.vcs).toBe("git")
    }
  })
})
