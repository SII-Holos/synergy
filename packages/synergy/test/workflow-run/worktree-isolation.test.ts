import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { WorkflowSeats } from "../../src/workflow-run/seats"
import type { Workspace } from "../../src/session/types"

describe("seat worktree creation isolation", () => {
  test("does not repoint the caller's ambient workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    // Simulate the Boss's live turn: a workspace is bound in the ambient frame.
    const bossWorkspace: Workspace = { type: "main", path: scope.directory, scopeID: scope.id }

    await ScopeContext.provide({
      scope,
      workspace: bossWorkspace,
      fn: async () => {
        const seat = await Session.create({ scope })
        expect(ScopeContext.current.workspace?.path).toBe(bossWorkspace.path)

        await WorkflowSeats.createSeatWorktree(seat.id, "isolation-seat")

        // The ambient workspace must be unchanged — the seat's worktree switch
        // stays confined to its own frame.
        expect(ScopeContext.current.workspace?.path).toBe(bossWorkspace.path)
        expect(ScopeContext.current.workspace?.type).toBe("main")

        // …while the seat session persistently owns the new worktree.
        const seatAfter = await Session.get(seat.id)
        expect(seatAfter.workspace?.type).toBe("git_worktree")
        expect(seatAfter.workspace?.path).not.toBe(bossWorkspace.path)
      },
    })
  })
})
