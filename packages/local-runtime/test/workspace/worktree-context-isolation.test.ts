import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "../../src/workspace/worktree"
import { testRuntime } from "../support/runtime"

test.skipIf(process.platform === "win32")(
  "binding a child session worktree inside a foreign ambient task must not pollute the ambient workspace context",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const parent = await Session.create({})
          const child = await Session.create({})
          const parentWorkspace = ScopeContext.current.workspace
          expect(parentWorkspace?.path).toBe(tmp.path)
          await WorkspaceAccess.task({ sessionID: parent.id, workspace: parent.workspace }, async () => {
            await Worktree.create({ name: "ctx-child", sessionID: child.id, bind: true, baseRef: "current" })
            const ambient = ScopeContext.tryWorkspace()
            expect(ambient?.path).toBe(tmp.path)
            expect(ambient?.type).not.toBe("git_worktree")
            const childAfter = await Session.get(child.id)
            expect(childAfter.workspace?.type).toBe("git_worktree")
          })
        },
      })
    })
  },
  30000,
)

test.skipIf(process.platform === "win32")(
  "entering a worktree from the owning session still refreshes the ambient workspace context",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const session = await Session.create({})
          await WorkspaceAccess.task({ sessionID: session.id, workspace: session.workspace }, async () => {
            await Worktree.create({ name: "ctx-own", sessionID: session.id, bind: true, baseRef: "current" })
            const ambient = ScopeContext.tryWorkspace()
            expect(ambient?.type).toBe("git_worktree")
            expect(String(ambient?.path)).toContain("ctx-own")
          })
        },
      })
    })
  },
  30000,
)
