import { describe, expect, test, mock, afterEach } from "bun:test"
import { WorktreeEnterTool } from "../../src/tool/worktree-enter"
import { Worktree } from "../../src/project/worktree"
import { Instance } from "../../src/scope/instance"
import { PermissionNext } from "../../src/permission/next"
import { EnforcementError } from "../../src/enforcement/errors"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// worktree-enter.test.ts
//
// Tests for WorktreeEnterTool — create or enter a git worktree.
//
// Scenarios:
//   1. Schema validation (accepts valid, rejects invalid baseRef)
//   2. Noop when session already in a git_worktree
//   3. Permission denied returns semantic denial output
//   4. Target matches existing worktree by name/ID
//   5. No target or no match creates new worktree
//   6. NOT_GIT error returns semantic denial
//   7. Setup failure returns semantic denial
// ---------------------------------------------------------------------------

const baseCtx = {
  sessionID: "ses_test1234567890abcde",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

/** Build params with defaults filled for the strict output type */
function params(overrides: Record<string, unknown> = {}) {
  return { baseRef: "current" as const, force: false, ...overrides }
}

// Save original Worktree methods for restoration between tests
const _origWorktree = {
  list: Worktree.list,
  create: Worktree.create,
  enter: Worktree.enter,
}

afterEach(() => {
  ;(Worktree as any).list = _origWorktree.list
  ;(Worktree as any).create = _origWorktree.create
  ;(Worktree as any).enter = _origWorktree.enter
})

describe("tool.worktree_enter", () => {
  // ---- Schema validation ----
  describe("schema validation", () => {
    test("accepts valid input with all optional fields", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse(
        params({
          target: "my-worktree",
          baseRef: "fresh",
          reason: "testing worktree entry",
          force: true,
        }),
      )
      expect(result.success).toBe(true)
    })

    test("accepts minimal input with no optional fields", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse(params({}))
      expect(result.success).toBe(true)
    })

    test("accepts baseRef 'current'", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse(params({ baseRef: "current" }))
      expect(result.success).toBe(true)
    })

    test("accepts baseRef 'fresh'", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse(params({ baseRef: "fresh" }))
      expect(result.success).toBe(true)
    })

    test("rejects invalid baseRef values", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse({ baseRef: "invalid", force: false })
      expect(result.success).toBe(false)
    })

    test("rejects empty string target", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse({ target: "", baseRef: "current", force: false })
      expect(result.success).toBe(false)
    })

    test("rejects non-string target", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse({ target: 123, baseRef: "current", force: false })
      expect(result.success).toBe(false)
    })

    test("defaults baseRef to 'current' when omitted", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse({ force: false })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.baseRef).toBe("current")
      }
    })

    test("defaults force to false when omitted", async () => {
      const initialized = await WorktreeEnterTool.init()
      const result = initialized.parameters.safeParse({ baseRef: "current" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.force).toBe(false)
      }
    })
  })

  // ---- Noop: already in worktree ----
  describe("noop: already in worktree", () => {
    test("returns action 'entered' when session is already in a git_worktree", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/brave-cactus",
          scopeID: "scope_123",
          worktreeID: "wt_existing",
          name: "brave-cactus",
        },
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "anything" }), ctx)

          expect(result.metadata.action).toBe("entered")
          expect(result.metadata.created).toBe(false)
          expect(result.metadata.workspace).toBeDefined()
          expect(result.metadata.message).toContain("already in worktree")
          expect(result.output).toContain("Already in worktree")
          expect(result.output).toContain("brave-cactus")
        },
      })
    })

    test("noop does not call Worktree.list or create", async () => {
      await using tmp = await tmpdir({ git: true })
      const listSpy = mock(async () => [] as any[])
      const createSpy = mock(async () => ({}) as any)
      ;(Worktree as any).list = listSpy
      ;(Worktree as any).create = createSpy

      await Instance.provide({
        scope: await tmp.scope(),
        workspace: {
          type: "git_worktree",
          path: "/tmp/wt",
          scopeID: "scope_123",
          worktreeID: "wt_abc",
          name: "existing",
        },
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await initialized.execute(params({ target: "anything" }), ctx)

          expect(listSpy).not.toHaveBeenCalled()
          expect(createSpy).not.toHaveBeenCalled()
        },
      })
    })
  })

  // ---- Permission denied ----
  describe("permission denied", () => {
    test("returns denial metadata on RejectedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new PermissionNext.RejectedError()
            }),
          }
          const result = await initialized.execute(params({ target: "test-wt" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("user_denied")
          expect(result.output).toBe("User declined worktree for this task.")
        },
      })
    })

    test("returns denial with feedback message on CorrectedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new PermissionNext.CorrectedError("Please use a different worktree name")
            }),
          }
          const result = await initialized.execute(params({ target: "test-wt" }), ctx)

          expect(result.output).toBe(
            "The user rejected permission to use this specific tool call with the following feedback: Please use a different worktree name",
          )
        },
      })
    })

    test("returns denial on DeniedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new PermissionNext.DeniedError([])
            }),
          }
          const result = await initialized.execute(params({ target: "test-wt" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("user_denied")
          expect(result.output).toBe("User declined worktree for this task.")
        },
      })
    })

    test("returns denial on EnforcementError.PolicyDenied", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new EnforcementError.PolicyDenied("Denied by enforcement policy", [], "autonomous")
            }),
          }
          const result = await initialized.execute(params({ target: "test-wt" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("user_denied")
          expect(result.output).toBe("User declined worktree for this task.")
        },
      })
    })

    test("rethrows non-permission errors", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const initialized = await WorktreeEnterTool.init()
          const ctx: any = {
            ...baseCtx,
            ask: mock(async () => {
              throw new Error("Network failure")
            }),
          }
          await expect(initialized.execute(params({ target: "test-wt" }), ctx)).rejects.toThrow("Network failure")
        },
      })
    })
  })

  // ---- Enter existing worktree ----
  describe("enter existing worktree", () => {
    test("enters by name match", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const mockWt = {
            id: "wt_match",
            name: "my-worktree",
            branch: "synergy/my-worktree",
            path: "/tmp/worktrees/my-worktree",
            scopeID: "scope_123",
          }
          ;(Worktree as any).list = mock(async () => [mockWt])
          ;(Worktree as any).enter = mock(async () => mockWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "my-worktree" }), ctx)

          expect(result.metadata.action).toBe("entered")
          expect(result.metadata.created).toBe(false)
          expect(result.metadata.worktree).toBe(mockWt)
          expect(result.metadata.workspace?.type).toBe("git_worktree")
          expect(result.metadata.workspace?.name).toBe("my-worktree")
          expect(result.output).toContain("Entered existing worktree")
        },
      })
    })

    test("enters by ID match", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const mockWt = {
            id: "wt_target_id",
            name: "other-name",
            branch: "synergy/other-name",
            path: "/tmp/worktrees/other-name",
            scopeID: "scope_123",
          }
          ;(Worktree as any).list = mock(async () => [mockWt])
          ;(Worktree as any).enter = mock(async () => mockWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "wt_target_id" }), ctx)

          expect(result.metadata.action).toBe("entered")
          expect(result.metadata.worktree).toBe(mockWt)
        },
      })
    })

    test("enters by branch match", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const mockWt = {
            id: "wt_123",
            name: "random-name",
            branch: "feature/experiment",
            path: "/tmp/wt",
            scopeID: "scope_123",
          }
          ;(Worktree as any).list = mock(async () => [mockWt])
          ;(Worktree as any).enter = mock(async () => mockWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "feature/experiment" }), ctx)

          expect(result.metadata.action).toBe("entered")
        },
      })
    })

    test("enters by path match", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const mockWt = {
            id: "wt_path",
            name: "path-worktree",
            path: "/home/user/project/.synergy/worktrees/path-worktree",
            scopeID: "scope_123",
          }
          ;(Worktree as any).list = mock(async () => [mockWt])
          ;(Worktree as any).enter = mock(async () => mockWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(
            params({ target: "/home/user/project/.synergy/worktrees/path-worktree" }),
            ctx,
          )

          expect(result.metadata.action).toBe("entered")
        },
      })
    })
  })

  // ---- Create new worktree ----
  describe("create new worktree", () => {
    test("creates new worktree when target does not match any existing", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const createdWt = {
            id: "wt_new",
            name: "new-worktree",
            branch: "synergy/new-worktree",
            path: "/tmp/worktrees/new-worktree",
            scopeID: "scope_123",
          }
          ;(Worktree as any).list = mock(async () => []) // no match
          ;(Worktree as any).create = mock(async () => createdWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "new-worktree", baseRef: "current" }), ctx)

          expect(result.metadata.action).toBe("entered")
          expect(result.metadata.created).toBe(true)
          expect(result.metadata.worktree).toBe(createdWt)
          expect(result.metadata.message).toContain("Created new worktree")
          expect(result.output).toContain("Created and entered worktree")
        },
      })
    })

    test("creates with auto-generated name when no target", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const createdWt = {
            id: "wt_auto",
            name: "brave-cactus-abc123",
            branch: "synergy/brave-cactus-abc123",
            path: "/tmp/worktrees/brave-cactus-abc123",
            scopeID: "scope_123",
          }
          ;(Worktree as any).create = mock(async () => createdWt)

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({}), ctx)

          expect(result.metadata.action).toBe("entered")
          expect(result.metadata.created).toBe(true)
          expect(result.metadata.worktree).toBe(createdWt)
        },
      })
    })

    test("passes baseRef to Worktree.create", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const createdWt = {
            id: "wt_fresh",
            name: "fresh-wt",
            path: "/tmp/worktrees/fresh-wt",
            scopeID: "scope_123",
          }
          const createSpy = mock(async () => createdWt)
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = createSpy

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await initialized.execute(params({ target: "fresh-wt", baseRef: "fresh" }), ctx)

          expect(createSpy).toHaveBeenCalledTimes(1)
          const callArg = (createSpy as any).mock.calls[0][0]
          expect(callArg.baseRef).toBe("fresh")
          expect(callArg.name).toBe("fresh-wt")
        },
      })
    })
  })

  // ---- NotGit error ----
  describe("not git error", () => {
    test("returns denial when list throws NotGitError during match phase", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => {
            throw new Worktree.NotGitError({ message: "Current scope is not a Git repository" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "test-wt" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("not_git_scope")
          expect(result.output).toContain("not a Git repository")
        },
      })
    })

    test("returns denial when create throws NotGitError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => []) // no match, falls through to create
          ;(Worktree as any).create = mock(async () => {
            throw new Worktree.NotGitError({ message: "Current scope is not a Git repository" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({}), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("not_git_scope")
        },
      })
    })
  })

  // ---- Setup failure ----
  describe("setup failure", () => {
    test("returns denial on NameGenerationFailedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = mock(async () => {
            throw new Worktree.NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({}), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("setup_failed")
          expect(result.output).toBe("Failed to generate a unique worktree name")
        },
      })
    })

    test("returns denial on CreateFailedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = mock(async () => {
            throw new Worktree.CreateFailedError({ message: "Failed to create git worktree" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "bad" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("setup_failed")
          expect(result.output).toBe("Failed to create git worktree")
        },
      })
    })

    test("returns denial on SetupConfigError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = mock(async () => {
            throw new Worktree.SetupConfigError({ message: "Invalid worktree setup file" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "bad" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("setup_failed")
        },
      })
    })

    test("returns denial on StartCommandFailedError", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = mock(async () => {
            throw new Worktree.StartCommandFailedError({ message: "Worktree setup command failed: npm install" })
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          const result = await initialized.execute(params({ target: "bad" }), ctx)

          expect(result.metadata.action).toBe("denied")
          expect(result.metadata.reason).toBe("setup_failed")
          expect(result.output).toContain("Worktree setup command failed")
        },
      })
    })

    test("rethrows unknown errors during create", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          ;(Worktree as any).list = mock(async () => [])
          ;(Worktree as any).create = mock(async () => {
            throw new TypeError("Something unexpected")
          })

          const initialized = await WorktreeEnterTool.init()
          const ctx: any = { ...baseCtx, ask: mock(async () => {}) }
          await expect(initialized.execute(params({}), ctx)).rejects.toThrow("Something unexpected")
        },
      })
    })
  })
})
