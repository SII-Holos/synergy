import path from "node:path"
import { describe, expect, test, mock, afterEach } from "bun:test"
import { WorktreeListTool } from "@ericsanchezok/synergy-workbench/project/tools/worktree-list"
import { Worktree } from "@ericsanchezok/synergy-runtime-local/workspace/worktree"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// worktree-list.test.ts
//
// Tests for WorktreeListTool — list all git worktrees.
//
// Scenarios:
//   1. Returns empty list for scope with no worktrees
//   2. Returns list with active worktree marked
//   3. Returns cleanup recommendations (keep, safe_to_remove, inspect_dirty,
//      external_do_not_manage)
//   4. Active matches by path from ScopeContext.current.workspace
// ---------------------------------------------------------------------------

const baseCtx = {
  sessionID: "ses_test1234567890abcde",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

// Save original Worktree.list for restoration between tests
const _origList = Worktree.list

afterEach(() =>
  runtime.run(() => {
    ;(Worktree as any).list = _origList
  }),
)

describe("tool.worktree_list", () => {
  // ---- Schema ----
  describe("schema", () => {
    test("accepts empty parameters object", () =>
      runtime.run(async () => {
        const initialized = await WorktreeListTool.init()
        const result = initialized.parameters.safeParse({})
        expect(result.success).toBe(true)
      }))
  })

  // ---- Empty list ----
  describe("empty list", () => {
    test("returns listed action with empty worktrees array", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            ;(Worktree as any).list = mock(async () => [])

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.metadata.action).toBe("listed")
            expect(result.metadata.worktrees).toEqual([])
            expect(result.metadata.active).toBeNull()
            expect(result.output).toContain("0 worktrees")
          },
        })
      }))
  })

  // ---- Active worktree ----
  describe("active worktree", () => {
    test("marks worktree as active when path matches ScopeContext.current.workspace", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          workspace: {
            type: "git_worktree",
            path: path.join(tmp.path, "worktrees/brave-cactus"),
            scopeID: scope.id,
            worktreeID: "wt_active",
            name: "brave-cactus",
          },
          fn: async () => {
            const worktrees = [
              { id: "wt_main", name: "main", path: "/tmp/repo", isMain: true, scopeID: scope.id },
              {
                id: "wt_active",
                name: "brave-cactus",
                path: path.join(tmp.path, "worktrees/brave-cactus"),
                isMain: false,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.metadata.action).toBe("listed")
            expect(result.metadata.active).not.toBeNull()
            expect(result.metadata.active?.id).toBe("wt_active")
            expect(result.metadata.active?.name).toBe("brave-cactus")
            expect(result.metadata.worktrees.length).toBe(2)
            expect(result.output).toContain("Active: brave-cactus")
          },
        })
      }))

    test("active is null when no workspace matches any worktree", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          workspace: {
            type: "git_worktree",
            path: path.join(tmp.path, "worktrees/nonexistent"),
            scopeID: scope.id,
            worktreeID: "wt_missing",
            name: "nonexistent",
          },
          fn: async () => {
            const worktrees = [{ id: "wt_main", name: "main", path: "/tmp/repo", isMain: true, scopeID: scope.id }]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.metadata.active).toBeNull()
            expect(result.output).toContain("Active: none")
          },
        })
      }))

    test("active is null when no workspace set", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [{ id: "wt_main", name: "main", path: "/tmp/repo", isMain: true, scopeID: scope.id }]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.metadata.active).toBeNull()
            expect(result.output).toContain("Active: none")
          },
        })
      }))
  })

  // ---- Cleanup recommendations ----
  describe("cleanup recommendations", () => {
    test("active worktree gets 'keep' recommendation", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          workspace: {
            type: "git_worktree",
            path: path.join(tmp.path, "worktrees/my-wt"),
            scopeID: scope.id,
            worktreeID: "wt_abc",
            name: "my-wt",
          },
          fn: async () => {
            const worktrees = [
              {
                id: "wt_main",
                name: "main",
                path: "/tmp/repo",
                isMain: true,
                managed: true,
                scopeID: scope.id,
              },
              {
                id: "wt_abc",
                name: "my-wt",
                path: path.join(tmp.path, "worktrees/my-wt"),
                isMain: false,
                managed: true,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const activeWt = result.metadata.worktrees.find((w: any) => w.id === "wt_abc")
            expect(activeWt?.cleanupRecommendation).toBe("keep")

            // main worktree should also be 'keep' (via isMain check)
            const mainWt = result.metadata.worktrees.find((w: any) => w.id === "wt_main")
            expect(mainWt?.cleanupRecommendation).toBe("keep")
          },
        })
      }))

    test("stale managed worktree gets 'safe_to_remove'", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              {
                id: "wt_main",
                name: "main",
                path: "/tmp/repo",
                isMain: true,
                managed: true,
                scopeID: scope.id,
              },
              {
                id: "wt_stale",
                name: "old-wt",
                path: path.join(tmp.path, "worktrees/old-wt"),
                isMain: false,
                managed: true,
                stale: true,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const staleWt = result.metadata.worktrees.find((w: any) => w.id === "wt_stale")
            expect(staleWt?.cleanupRecommendation).toBe("safe_to_remove")
          },
        })
      }))

    test("dirty managed worktree gets 'inspect_dirty'", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              {
                id: "wt_main",
                name: "main",
                path: "/tmp/repo",
                isMain: true,
                managed: true,
                scopeID: scope.id,
              },
              {
                id: "wt_dirty",
                name: "dirty-wt",
                path: path.join(tmp.path, "worktrees/dirty-wt"),
                isMain: false,
                managed: true,
                dirty: true,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const dirtyWt = result.metadata.worktrees.find((w: any) => w.id === "wt_dirty")
            expect(dirtyWt?.cleanupRecommendation).toBe("inspect_dirty")
          },
        })
      }))

    test("external (non-managed) worktree gets 'external_do_not_manage'", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              {
                id: "wt_main",
                name: "main",
                path: "/tmp/repo",
                isMain: true,
                managed: true,
                scopeID: scope.id,
              },
              {
                id: "wt_external",
                name: "external-wt",
                path: path.join(tmp.path, "worktrees/external-wt"),
                isMain: false,
                managed: false,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const extWt = result.metadata.worktrees.find((w: any) => w.id === "wt_external")
            expect(extWt?.cleanupRecommendation).toBe("external_do_not_manage")
          },
        })
      }))

    test("not dirty, not stale, not active non-main worktree gets 'keep'", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              {
                id: "wt_idle",
                name: "idle-wt",
                path: path.join(tmp.path, "worktrees/idle-wt"),
                isMain: false,
                managed: true,
                stale: false,
                dirty: false,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const idleWt = result.metadata.worktrees.find((w: any) => w.id === "wt_idle")
            expect(idleWt?.cleanupRecommendation).toBe("keep")
          },
        })
      }))

    test("stale gets priority over dirty when both set", () =>
      runtime.run(async () => {
        // If a worktree is both stale and dirty, the stale check comes first
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              {
                id: "wt_conflict",
                name: "conflict-wt",
                path: path.join(tmp.path, "worktrees/conflict-wt"),
                isMain: false,
                managed: true,
                stale: true,
                dirty: true,
                scopeID: scope.id,
              },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            const wt = result.metadata.worktrees.find((w: any) => w.id === "wt_conflict")
            expect(wt?.cleanupRecommendation).toBe("safe_to_remove")
          },
        })
      }))
  })

  // ---- Pluralization ----
  describe("output message formatting", () => {
    test("uses singular 'worktree' for single result", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              { id: "wt_main", name: "main", path: "/tmp/repo", isMain: true, managed: true, scopeID: scope.id },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.output).toContain("1 worktree found")
            expect(result.output).not.toContain("worktrees")
          },
        })
      }))

    test("uses plural 'worktrees' for multiple results", () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const worktrees = [
              { id: "wt_main", name: "main", path: "/tmp/repo", isMain: true, managed: true, scopeID: scope.id },
              { id: "wt_a", name: "a", path: path.join(tmp.path, "worktrees/a"), isMain: false, scopeID: scope.id },
            ]
            ;(Worktree as any).list = mock(async () => worktrees)

            const initialized = await WorktreeListTool.init()
            const ctx: any = { ...baseCtx }
            const result = await initialized.execute({}, ctx)

            expect(result.output).toContain("2 worktrees found")
          },
        })
      }))
  })
})

afterRuntimeTests(() => runtime.close())
