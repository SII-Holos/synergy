// ---------------------------------------------------------------------------
// snapshot-timeout-regression.test.ts
//
// Regression test for Snapshot.track() timeout / fail-open behavior.
//
// Root cause context:
//   Snapshot.track() and Snapshot.patch() run git add/write-tree/diff from the
//   session processor stream loop. These operations must be bounded because a
//   large worktree or stuck git index lock can otherwise stall the whole
//   session loop.
//
//   Expected behavior: normal snapshot operations stay fast on small repos, and
//   production snapshot git commands fail open through timeout/AbortSignal
//   guards instead of blocking the session indefinitely.
//
// Testing strategy:
//   1. Integration test: verify normal Snapshot.track() completes within a
//      reasonable wall-clock time.
//   2. Integration test: verify Snapshot.patch() also stays bounded on a small
//      repo and still reports changed files.
//   3. Keep timeout behavior centralized in Snapshot's git command helper so
//      future direct shell calls don't re-enter the hot path unbounded.
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeAll } from "bun:test"
import path from "path"
import { Snapshot } from "../../src/session/snapshot"
import { Instance } from "../../src/scope/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"

function fakeSessionID(): string {
  return Identifier.descending("session")
}

// ===========================================================================
// Regression test: Snapshot.track() completes within timeout
// ===========================================================================

describe("Snapshot.track() — completes within reasonable time", () => {
  test("track() on a small git repo returns a hash in under 2 seconds", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Write a few files
        await Bun.write(path.join(tmp.path, "a.txt"), "content a")
        await Bun.write(path.join(tmp.path, "b.txt"), "content b")

        const sessionID = fakeSessionID()

        const start = Date.now()
        const hash = await Snapshot.track(sessionID)
        const elapsed = Date.now() - start

        expect(hash, "track() should return a tree hash").toBeTruthy()
        expect(typeof hash, "hash should be a string").toBe("string")
        expect((hash as string).length, "tree hash should be 40 chars").toBe(40)

        // The operation should complete in under 2 seconds for a trivial repo.
        // If this fails, it means the git commands are hanging.
        expect(elapsed, "track() should complete in under 2s").toBeLessThan(2000)
      },
    })
  })

  test("patch() on a small repo completes in under 2 seconds", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = fakeSessionID()

        await Bun.write(path.join(tmp.path, "a.txt"), "version 1")
        const hash = await Snapshot.track(sessionID)
        expect(hash).toBeTruthy()

        await Bun.write(path.join(tmp.path, "a.txt"), "version 2")

        const start = Date.now()
        const patch = await Snapshot.patch(hash!, sessionID)
        const elapsed = Date.now() - start

        expect(elapsed, "patch() should complete in under 2s").toBeLessThan(2000)
        expect(patch.files.length, "patch should detect changed file").toBeGreaterThan(0)
      },
    })
  })
})
