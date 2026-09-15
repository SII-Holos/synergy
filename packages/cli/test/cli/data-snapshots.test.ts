import { expect, test } from "bun:test"
import { executeSnapshots } from "../../src/cli/cmd/data/snapshots"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import path from "node:path"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("a filtered migration preserves unrelated repositories and reconstructs selected history", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const sessions = [await Session.create({ scope }), await Session.create({ scope })]
      const repositories = sessions.map((session) => SnapshotStore.legacyRepository(scope.id, session.id))
      await Bun.write(path.join(tmp.path, "history.txt"), "retained history")
      for (const repo of repositories) {
        await SnapshotStore.initializeBareRepository(repo)
        await SnapshotStore.command(repo, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
      }
      const tree = await SnapshotStore.command(repositories[0], ["write-tree"])
      const result = await executeSnapshots({
        action: "migrate",
        scope: scope.id,
        session: sessions[0].id,
        apply: true,
      })
      expect(result.ok).toBe(true)
      expect(await Bun.file(path.join(repositories[0], "HEAD")).exists()).toBe(false)
      expect(await Bun.file(path.join(repositories[1], "HEAD")).exists()).toBe(true)
      expect(await SnapshotStore.owner(scope.id, sessions[1].id)).toBeUndefined()
      expect(await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${tree}:history.txt`])).toBe(
        "retained history",
      )
    },
  })
})

test("snapshot maintenance defaults to dry-run and rejects apply while a server owns the home", async () => {
  const lock = await ServerProcessLock.acquire()
  try {
    expect((await executeSnapshots({ action: "migrate", scope: "empty-cli-scope" })).ok).toBe(true)
    const busy = await executeSnapshots({ action: "compact", scope: "empty-cli-scope", apply: true })
    expect(busy.ok).toBe(false)
    expect(busy).toMatchObject({ error: { code: "busy" } })
    expect((await executeSnapshots({ action: "clean", scope: "empty-cli-scope" })).ok).toBe(true)
    const cleanBusy = await executeSnapshots({ action: "clean", scope: "empty-cli-scope", apply: true })
    expect(cleanBusy.ok).toBe(false)
    expect(cleanBusy).toMatchObject({ error: { code: "busy" } })
  } finally {
    await lock.release()
  }
})
