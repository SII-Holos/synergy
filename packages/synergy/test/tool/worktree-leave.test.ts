import { describe, expect, test, mock, afterEach } from "bun:test"
import { WorktreeLeaveTool } from "../../src/tool/worktree-leave"
import { Worktree } from "../../src/project/worktree"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// worktree-leave.test.ts
//
// Tests for WorktreeLeaveTool — leave the current git worktree.
//
// Scenarios:
//   1. Schema accepts valid input (cleanup, reason)
//   2. Noop when session is on main checkout
//   3. Permission denied returns semantic denial
//   4. Leave keeps worktree when cleanup=keep (default)
//   5. Leave removes clean worktree when cleanup=remove_if_clean
//   6. Leave keeps dirty worktree when cleanup=remove_if_clean
// ---------------------------------------------------------------------------

const baseCtx = {
  sessionID: "ses_test1234567890abcde",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

// Save original Worktree methods for restoration between tests
const _origWorktree = {
  leave: Worktree.leave,
  status: Worktree.status,
  remove: Worktree.remove,
}

afterEach(() => {
  ;(Worktree as any).leave = _origWorktree.leave
  ;(Worktree as any).status = _origWorktree.status
  ;(Worktree as any).remove = _origWorktree.remove
})

describe("tool.worktree_leave", () => {
  // ---- Schema validation ----
  describe("schema validation", () => {
    test("accepts no parameters (all optional with defaults)", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({})
      expect(result.success).toBe(true)
    })

    test("accepts cleanup 'keep'", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({ cleanup: "keep" })
      expect(result.success).toBe(true)
    })

    test("accepts cleanup 'remove_if_clean'", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({ cleanup: "remove_if_clean" })
      expect(result.success).toBe(true)
    })

    test("rejects invalid cleanup values", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({ cleanup: "delete" })
      expect(result.success).toBe(false)
    })

    test("accepts optional reason string", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({ cleanup: "keep", reason: "task complete" })
      expect(result.success).toBe(true)
    })

    test("defaults cleanup to 'keep' when omitted", async () => {
      const initialized = await WorktreeLeaveTool.init()
      const result = initialized.parameters.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.cleanup).toBe("keep")
      }
    })
  })

  // ---- Noop: already on main ----
  describe("noop: already on main", () => {
    test("returns noop when session has no workspace", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute({ cleanup: "keep" }, ctx)

          expect(result.metadata.action).toBe("noop")
          expect(result.metadata.reason).toBe("already_on_main")
          expect(result.output).toContain("Already on the main checkout")
        },
      })
    })

    test("returns noop when workspace is not git_worktree type", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "main",
          path: "/home/user/project",
          scopeID: "scope_123",
        },
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute({ cleanup: "keep" }, ctx)

          expect(result.metadata.action).toBe("noop")
          expect(result.metadata.reason).toBe("already_on_main")
        },
      })
    })

    test("noop does not call Worktree.leave or Worktree.status", async () => {
      await using tmp = await tmpdir({ git: true })
      const leaveSpy = mock(async () => {})
      const statusSpy = mock(async () => ({ dirty: undefined }))
      ;(Worktree as any).leave = leaveSpy
      ;(Worktree as any).status = statusSpy

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await initialized.execute({ cleanup: "keep" }, ctx)

          expect(leaveSpy).not.toHaveBeenCalled()
          expect(statusSpy).not.toHaveBeenCalled()
        },
      })
    })
  })

  // ---- Permission denied ----
  describe("permission denied", () => {
    test("returns semantic denial on RejectedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/brave-cactus",
          scopeID: "scope_123",
          worktreeID: "wt_existing",
          name: "brave-cactus",
        },
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new PermissionNext.RejectedError()
            }),
          }
          const result = await initialized.execute({ cleanup: "keep" }, ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("user_denied")
          expect(result.output).toBe("User declined leaving the worktree.")
        },
      })
    })

    test("returns semantic denial on DeniedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/brave-cactus",
          scopeID: "scope_123",
          worktreeID: "wt_existing",
          name: "brave-cactus",
        },
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new PermissionNext.DeniedError([])
            }),
          }
          const result = await initialized.execute({ cleanup: "keep" }, ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("user_denied")
        },
      })
    })

    test("throws non-permission errors", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/test",
          scopeID: "scope_123",
          worktreeID: "wt_test",
          name: "test",
        },
        fn: async () => {
          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new Error("Network failure")
            }),
          }
          await expect(initialized.execute({ cleanup: "keep" }, ctx)).rejects.toThrow("Network failure")
        },
      })
    })
  })

  // ---- Leave with cleanup=keep (default) ----
  describe("leave with cleanup=keep", () => {
    test("leaves worktree and returns to main without removing", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/brave-cactus",
          scopeID: "scope_123",
          worktreeID: "wt_existing",
          name: "brave-cactus",
        },
        fn: async () => {
          ;(Worktree as any).leave = mock(async () => {})
          ;(Worktree as any).status = mock(async () => ({ dirty: undefined }))

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute({ cleanup: "keep" }, ctx)

          expect(result.metadata.action).toBe("left")
          expect(result.metadata.previous).toBeDefined()
          expect(result.metadata.previous?.type).toBe("git_worktree")
          expect(result.metadata.previous?.path).toBe("/tmp/worktrees/brave-cactus")
          expect(result.metadata.restored).toBeDefined()
          expect(result.metadata.restored?.type).toBe("main")
          expect(result.metadata.cleanup?.performed).toBe(false)
          expect(result.output).toContain("Left worktree")
          expect(result.output).toContain("returned to main checkout")
        },
      })
    })

    test("calls Worktree.leave with correct sessionID", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/wt",
          scopeID: "scope_123",
          worktreeID: "wt_abc",
          name: "test",
        },
        fn: async () => {
          const leaveSpy = mock(async () => {})
          ;(Worktree as any).leave = leaveSpy

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = {
            ...baseCtx,
            sessionID: "ses_target_session",
            ask: mock(async () => {}),
          }
          await initialized.execute({ cleanup: "keep" }, ctx)

          expect(leaveSpy).toHaveBeenCalledTimes(1)
          expect((leaveSpy as any).mock.calls[0][0]).toBe("ses_target_session")
        },
      })
    })

    test("does not call Worktree.remove when cleanup=keep", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/wt",
          scopeID: "scope_123",
          worktreeID: "wt_abc",
          name: "test",
        },
        fn: async () => {
          const removeSpy = mock(async () => ({}) as any)
          ;(Worktree as any).leave = mock(async () => {})
          ;(Worktree as any).remove = removeSpy

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await initialized.execute({ cleanup: "keep" }, ctx)

          expect(removeSpy).not.toHaveBeenCalled()
        },
      })
    })
  })

  // ---- Leave with cleanup=remove_if_clean ----
  describe("leave with cleanup=remove_if_clean", () => {
    test("removes clean worktree after leaving", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/clean-wt",
          scopeID: "scope_123",
          worktreeID: "wt_clean",
          name: "clean-wt",
        },
        fn: async () => {
          const removeSpy = mock(async () => ({}) as any)
          ;(Worktree as any).leave = mock(async () => {})
          ;(Worktree as any).status = mock(async () => ({ dirty: false }))
          ;(Worktree as any).remove = removeSpy

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute({ cleanup: "remove_if_clean" }, ctx)

          expect(result.metadata.action).toBe("left")
          expect(result.metadata.cleanup?.performed).toBe(true)
          expect(result.output).toContain("Worktree removed (was clean)")
          expect(removeSpy).toHaveBeenCalledTimes(1)
          expect((removeSpy as any).mock.calls[0][0].target).toBe("wt_clean")
        },
      })
    })

    test("keeps dirty worktree when cleanup=remove_if_clean", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/dirty-wt",
          scopeID: "scope_123",
          worktreeID: "wt_dirty",
          name: "dirty-wt",
        },
        fn: async () => {
          const removeSpy = mock(async () => ({}) as any)
          ;(Worktree as any).leave = mock(async () => {})
          ;(Worktree as any).status = mock(async () => ({ dirty: true }))
          ;(Worktree as any).remove = removeSpy

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute({ cleanup: "remove_if_clean" }, ctx)

          expect(result.metadata.action).toBe("left")
          expect(result.metadata.cleanup?.performed).toBe(false)
          expect(result.metadata.cleanup?.skippedReason).toBe("dirty")
          expect(result.output).toContain("Worktree kept (has uncommitted changes)")
          expect(removeSpy).not.toHaveBeenCalled()
        },
      })
    })

    test("checks Worktree.status before deciding on cleanup", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/wt",
          scopeID: "scope_123",
          worktreeID: "wt_test",
          name: "test",
        },
        fn: async () => {
          const statusSpy = mock(async () => ({ dirty: false }))
          ;(Worktree as any).leave = mock(async () => {})
          ;(Worktree as any).status = statusSpy
          ;(Worktree as any).remove = mock(async () => ({}) as any)

          const initialized = await WorktreeLeaveTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await initialized.execute({ cleanup: "remove_if_clean" }, ctx)

          expect(statusSpy).toHaveBeenCalledTimes(1)
          expect((statusSpy as any).mock.calls[0][0]).toBe("ses_test1234567890abcde")
        },
      })
    })
  })
})
