import { expect, test } from "bun:test"
import { z } from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { ProjectDirectories } from "../../src/project/directories"
import { ProjectWorktrees } from "../../src/project/worktrees"
const changed = BusEvent.define("test.worktree-inventory.changed", z.object({}))
test("a cached inventory retains its generation watermark after newer Scope events", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir({ git: true })
  await runtime.run(async () => {
    const created = await ProjectDirectories.create({
      name: "Cached inventory",
      directories: [directory.path],
      mainDirectory: directory.path,
    })
    await ScopeContext.provide({
      scope: created.scope,
      workspace: null,
      fn: async () => {
        const first = await ProjectWorktrees.inventory(created.scope.id)
        const seq = Bus.currentSeq()
        await Bus.publish(changed, {})
        expect(Bus.currentSeq()).toBeGreaterThan(seq)
        const second = await ProjectWorktrees.inventory(created.scope.id)
        expect(second).toBe(first)
        expect(second.sync).toEqual({ epoch: Bus.epoch(), seq })
      },
    })
  })
})
