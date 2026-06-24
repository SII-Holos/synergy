import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { EnforcementGate } from "../../src/enforcement/gate"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { Info as InfoSchema, type Workspace } from "../../src/session/types"
import path from "path"

Log.init({ print: false })

/** Workspace shape the implementation will use */
interface SessionWorkspace {
  type: string
  path: string
  scopeID: string
  [key: string]: unknown
}

describe("session workspace binding", () => {
  // === Requirement 1: Session.Info can persist optional workspace metadata ===

  describe("Session.Info schema (workspace field)", () => {
    test("schema accepts optional workspace metadata", () => {
      const workspace: SessionWorkspace = {
        type: "main",
        path: "/some/path",
        scopeID: "d_abc123",
      }
      const data = {
        id: "ses_0123456789abcdefghijklmnopqrstuvwxyz0123456789ab",
        scope: { id: "d_abc123" },
        title: "test session",
        version: "0.0.0",
        time: { created: 1, updated: 1 },
        workspace,
      }
      const result = InfoSchema.safeParse(data)
      expect(result.success).toBe(true)
      if (result.success) {
        // Workspace must survive a parse round-trip (not be stripped)
        expect(result.data).toHaveProperty("workspace")
        expect((result.data as Record<string, unknown>).workspace).toEqual(workspace)
      }
    })

    test("schema allows missing workspace for backwards compatibility", () => {
      const data = {
        id: "ses_0123456789abcdefghijklmnopqrstuvwxyz0123456789ab",
        scope: { id: "d_abc123" },
        title: "legacy session",
        version: "0.0.0",
        time: { created: 1, updated: 1 },
      }
      const result = InfoSchema.safeParse(data)
      expect(result.success).toBe(true)
      expect((result as { success: true; data: Record<string, unknown> }).data?.workspace).toBeUndefined()
    })
  })

  // === Requirement 2: Session.create() with no workspace stores main workspace default ===

  describe("Session.create default workspace", () => {
    test("creates main workspace default when no workspace provided", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const session = await Session.create({})

            expect(session).toHaveProperty("workspace")
            const ws = (session as Record<string, unknown>).workspace as SessionWorkspace
            expect(ws).toBeDefined()
            expect(ws.type).toBe("main")
            expect(ws.path).toBe(scope.directory)
            expect(ws.scopeID).toBe(scope.id)

            const read = await Session.get(session.id)
            expect(read).toHaveProperty("workspace")
            const readWs = (read as Record<string, unknown>).workspace as SessionWorkspace
            expect(readWs).toEqual(ws)

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 3: Session.create({ workspace }) stores supplied workspace metadata ===

  describe("Session.create explicit workspace", () => {
    test("stores supplied workspace metadata", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const customWs: SessionWorkspace = {
              type: "custom-type",
              path: "/custom/workspace/path",
              scopeID: scope.id,
            }

            const session = await Session.create({ workspace: customWs })

            expect(session).toHaveProperty("workspace")
            const ws = session.workspace as SessionWorkspace
            expect(ws).toEqual(customWs)

            const read = await Session.get(session.id)
            const readWs = (read as Record<string, unknown>).workspace as SessionWorkspace
            expect(readWs).toEqual(customWs)

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 4: Session.updateWorkspace() updates workspace without mutating scope ===

  describe("Session.updateWorkspace", () => {
    test("updates workspace without mutating scope", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const session = await Session.create({})
            const originalScopeID = (session.scope as Scope).id
            const originalScopeDirectory = (session.scope as Scope).directory

            const newWs: SessionWorkspace = {
              type: "updated-workspace",
              path: "/new/workspace/path",
              scopeID: scope.id,
            }

            const updated = await Session.updateWorkspace(session.id, newWs)

            expect(updated).toHaveProperty("workspace")
            const ws = updated.workspace as SessionWorkspace
            expect(ws).toEqual(newWs)

            const updatedScope = updated.scope as Scope
            expect(updatedScope.id).toBe(originalScopeID)
            expect(updatedScope.directory).toBe(originalScopeDirectory)

            const read = await Session.get(session.id)
            const readWs = (read as Record<string, unknown>).workspace as SessionWorkspace
            expect(readWs).toEqual(newWs)

            const readScope = read.scope as Scope
            expect(readScope.id).toBe(originalScopeID)
            expect(readScope.directory).toBe(originalScopeDirectory)

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 5: SessionManager.run() makes ScopeContext.current.directory === session.workspace.path ===

  describe("ScopeContext.current.directory resolution (via workspace)", () => {
    test("ScopeContext.current.directory reflects session workspace path inside run context", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const ws: SessionWorkspace = {
              type: "main",
              path: "/workspace-driven-directory",
              scopeID: scope.id,
            }
            const session = await Session.create({ workspace: ws })

            await SessionManager.run(session.id, async () => {
              expect(ScopeContext.current.directory).toBe(ws.path)
              expect(ScopeContext.current.directory).not.toBe(scope.directory)
            })

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 6: ScopeContext.current.workspace and ScopeContext.current.worktree separation ===

  describe("ScopeContext.current.workspace and ScopeContext.current.worktree separation", () => {
    test("ScopeContext.current.workspace returns structured metadata", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const ws: SessionWorkspace = {
              type: "main",
              path: scope.directory,
              scopeID: scope.id,
            }
            const session = await Session.create({ workspace: ws })

            await SessionManager.run(session.id, async () => {
              const instWs = ScopeContext.current.workspace as SessionWorkspace | undefined
              expect(instWs).toBeDefined()
              expect(instWs!.type).toBe("main")
              expect(instWs!.path).toBe(scope.directory)
              expect(instWs!.scopeID).toBe(scope.id)
            })

            await Session.remove(session.id)
          })(),
      })
    })

    test("ScopeContext.current.worktree is scope.worktree, not workspace.path", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const ws: SessionWorkspace = {
              type: "main",
              path: "/some/workspace/path",
              scopeID: scope.id,
            }
            const session = await Session.create({ workspace: ws })

            await SessionManager.run(session.id, async () => {
              expect(ScopeContext.current.worktree).toBe(scope.worktree)
              expect(ScopeContext.current.worktree).not.toBe(ws.path)
            })

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 7: Legacy sessions without workspace fall back to scope.directory ===

  describe("legacy session backwards compatibility", () => {
    test("sessions without workspace resolve ScopeContext.current.directory to scope.directory", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const { Storage } = await import("../../src/storage/storage")
            const { StoragePath } = await import("../../src/storage/path")
            const { Identifier } = await import("../../src/id/id")

            const legacySession = {
              id: Identifier.descending("session"),
              scope: { id: scope.id, directory: scope.directory, worktree: scope.worktree },
              title: "legacy session",
              version: "0.0.0",
              time: { created: Date.now(), updated: Date.now() },
            }

            await Storage.write(
              StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(legacySession.id)),
              legacySession,
            )
            await Storage.write(
              StoragePath.sessionIndex(Identifier.asSessionID(legacySession.id)),
              Session.toIndex(legacySession as any),
            )

            SessionManager.registerRuntime(legacySession.id)

            await SessionManager.run(legacySession.id, async () => {
              expect(ScopeContext.current.directory).toBe(scope.directory)
            })

            SessionManager.unregisterRuntime(legacySession.id)
            await Session.remove(legacySession.id).catch(() => {})
          })(),
      })
    })
  })

  // === Requirement 8: child sessions inherit parent workspace exactly ===

  describe("child session workspace inheritance", () => {
    test("child sessions inherit parent workspace exactly", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const parentWs: SessionWorkspace = {
              type: "main",
              path: "/parent-custom-workspace",
              scopeID: scope.id,
            }

            const parent = await Session.create({ workspace: parentWs })
            const child = await Session.create({ parentID: parent.id })

            expect(child).toHaveProperty("workspace")
            const parentWsFromSession = parent.workspace as SessionWorkspace
            const childWs = child.workspace as SessionWorkspace
            expect(childWs).toEqual(parentWsFromSession)

            await Session.remove(parent.id)
          })(),
      })
    })
  })

  describe("mid-turn workspace refresh", () => {
    test("refreshes ScopeContext.current.directory after a worktree-style workspace switch", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const session = await Session.create({})
            const worktreeWs: SessionWorkspace = {
              type: "git_worktree",
              path: path.join(scope.directory, ".synergy-test-worktree"),
              scopeID: scope.id,
              worktreeID: "wt_test",
              name: "test-worktree",
            }

            await SessionManager.run(session.id, async () => {
              expect(ScopeContext.current.directory).toBe(scope.directory)

              await Session.updateWorkspace(session.id, worktreeWs)
              ScopeContext.refreshWorkspace(worktreeWs as Workspace)

              expect(ScopeContext.current.directory).toBe(worktreeWs.path)
              expect((ScopeContext.current.workspace as SessionWorkspace | undefined)?.type).toBe("git_worktree")
            })

            await Session.remove(session.id)
          })(),
      })
    })

    test("refreshes ScopeContext.current.directory after leaving a worktree-style workspace", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const worktreeWs: SessionWorkspace = {
              type: "git_worktree",
              path: path.join(scope.directory, ".synergy-test-worktree"),
              scopeID: scope.id,
              worktreeID: "wt_test",
              name: "test-worktree",
            }
            const session = await Session.create({})
            const mainWs: SessionWorkspace = {
              type: "main",
              path: scope.directory,
              scopeID: scope.id,
            }

            await ScopeContext.provide({
              scope,
              workspace: worktreeWs as Workspace,
              fn: async () => {
                expect(ScopeContext.current.directory).toBe(worktreeWs.path)

                await Session.updateWorkspace(session.id, mainWs)
                ScopeContext.refreshWorkspace(mainWs as Workspace)

                expect(ScopeContext.current.directory).toBe(scope.directory)
                expect((ScopeContext.current.workspace as SessionWorkspace | undefined)?.type).toBe("main")
              },
            })
            await Session.remove(session.id)
          })(),
      })
    })

    test("enforcement gates created after refresh use the new workspace", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: () =>
          using(async () => {
            const session = await Session.create({})
            const worktreeWs: SessionWorkspace = {
              type: "git_worktree",
              path: path.join(scope.directory, ".synergy-test-worktree"),
              scopeID: scope.id,
              worktreeID: "wt_test",
              name: "test-worktree",
            }

            await SessionManager.run(session.id, async () => {
              await Session.updateWorkspace(session.id, worktreeWs)
              ScopeContext.refreshWorkspace(worktreeWs as Workspace)

              const gate = (await EnforcementGate.create({
                activeWorkspace: ScopeContext.current.directory,
                workspaceType: ScopeContext.current.workspace?.type === "git_worktree" ? "worktree" : "main",
                profileId: "autonomous",
              })) as any

              expect(gate.evaluate("write", { filePath: path.join(worktreeWs.path, "src/file.ts") }).decision).toBe(
                "allow",
              )
              // autonomous denies file_external_write — cross-workspace writes are forbidden
              expect(gate.evaluate("write", { filePath: path.join(scope.directory, "src/file.ts") }).decision).toBe(
                "deny",
              )
              // autonomous: shell_hardline is denied, shell_destructive is deny (was ask)
              const classifyResult = gate.classify("bash", { command: "rm -rf /" })
              const hardline = classifyResult.capabilities.some((c: any) => c.class === "shell_hardline")
              const destructive = classifyResult.capabilities.some((c: any) => c.class === "shell_destructive")
              expect(hardline || destructive).toBe(true)
            })

            await Session.remove(session.id)
          })(),
      })
    })
  })
})

/**
 * Minimal async-dispose helper for sequential async cleanup in tests.
 */
function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

// === Requirement 9: Config sandbox key is optional and backward-compatible ===

describe("sandbox config compatibility", () => {
  test("Config.Info accepts optional sandbox key without error", async () => {
    const { Config } = await import("../../src/config/config")

    const withSandbox = Config.Info.safeParse({
      sandbox: {
        enabled: true,
        fallbackPolicy: "warn",
      },
    })
    expect(withSandbox.success).toBe(true)
    if (withSandbox.success) {
      expect(withSandbox.data).toHaveProperty("sandbox")
      expect((withSandbox.data as Record<string, unknown>).sandbox).toEqual({
        enabled: true,
        fallbackPolicy: "warn",
      })
    }
  })

  test("Config.Info accepts config without sandbox key (backward compatibility)", async () => {
    const { Config } = await import("../../src/config/config")

    const withoutSandbox = Config.Info.safeParse({})
    expect(withoutSandbox.success).toBe(true)
    if (withoutSandbox.success) {
      expect((withoutSandbox.data as Record<string, unknown>).sandbox).toBeUndefined()
    }
  })
})

// === Requirement 10: Workspace boundary enforcement integration ===

describe("workspace boundary enforcement with sandbox", () => {
  test("workspace policy drives outside_workspace classification for enforcement", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const { WorkspacePolicy } = await import("../../src/workspace/policy")

          const ws: SessionWorkspace = {
            type: "git_worktree",
            path: "/tmp/isolated-worktree",
            scopeID: scope.id,
          }
          const session = await Session.create({ workspace: ws })
          const policy = await WorkspacePolicy.fromSession(session)

          // Files outside the active workspace should be flagged
          expect(policy.contains("/tmp/isolated-worktree/src/foo.ts")).toBe(true)
          expect(policy.contains(path.join(scope.directory, "src/bar.ts"))).toBe(false)

          await Session.remove(session.id)
        })(),
    })
  })

  test("WorkspacePolicy respects active root for boundary checks", async () => {
    const { WorkspacePolicy } = await import("../../src/workspace/policy")

    const policy = WorkspacePolicy.create({
      activeRoot: "/workspace/synergy",
      workspaceType: "main",
      scopeID: "d_test123",
    })

    // WorkspacePolicy should reject paths outside the root
    expect(policy.contains("/workspace/synergy/src/app.ts")).toBe(true)
    expect(policy.contains("/etc/hostname")).toBe(false)
  })
})
