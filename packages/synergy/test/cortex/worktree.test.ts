import { describe, expect, test, mock, afterEach } from "bun:test"
import { Cortex } from "../../src/cortex"
import { Worktree } from "../../src/project/worktree"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const _origWorktree = {
  create: Worktree.create,
  enter: Worktree.enter,
  status: Worktree.status,
  remove: Worktree.remove,
}
const mutableWorktree = Worktree as unknown as {
  create: typeof Worktree.create
  enter: typeof Worktree.enter
  status: typeof Worktree.status
  remove: typeof Worktree.remove
}

afterEach(() => {
  Cortex.reset()
  mutableWorktree.create = _origWorktree.create
  mutableWorktree.enter = _origWorktree.enter
  mutableWorktree.status = _origWorktree.status
  mutableWorktree.remove = _origWorktree.remove
})

describe("Cortex worktree creation", () => {
  test("calls Worktree.create and Worktree.enter when worktree.create is requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const mockWt = {
          id: "wt_child_test",
          name: "child-worktree",
          branch: "synergy/child-worktree",
          path: "/tmp/.synergy/worktrees/child-worktree",
          scopeID: "scope_123",
        }
        const createSpy = mock(async (_input: Worktree.CreateInput) => mockWt)
        const enterSpy = mock(async (_input: Worktree.TargetInput) => mockWt)
        mutableWorktree.create = createSpy as unknown as typeof Worktree.create
        mutableWorktree.enter = enterSpy as unknown as typeof Worktree.enter

        const task = await Cortex.launch({
          description: "Create worktree child",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
          worktree: { create: true, name: "child-worktree", baseRef: "current" },
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(task?.ownedWorktreeID).toBe("wt_child_test")
        expect(createSpy).toHaveBeenCalledTimes(1)
        const createArg = createSpy.mock.calls[0]![0]
        expect(createArg.name).toBe("child-worktree")
        expect(createArg.baseRef).toBe("current")

        expect(enterSpy).toHaveBeenCalledTimes(1)
        const enterArg = enterSpy.mock.calls[0]![0]
        expect(enterArg.target).toBe("wt_child_test")
        expect(enterArg.sessionID).toBe(task!.sessionID)

        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("does not create worktree when worktree.create is not requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const createSpy = mock(async (_input: Worktree.CreateInput) => ({
          id: "unused",
          name: "unused",
          path: "unused",
          scopeID: ScopeContext.current.scope.id,
        }))
        mutableWorktree.create = createSpy as unknown as typeof Worktree.create

        const task = await Cortex.launch({
          description: "No worktree child",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(task?.ownedWorktreeID).toBeUndefined()
        expect(createSpy).not.toHaveBeenCalled()
        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("survives failed worktree creation gracefully", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const createSpy = mock(async (_input: Worktree.CreateInput) => {
          throw new Worktree.CreateFailedError({ message: "Disk full" })
        })
        mutableWorktree.create = createSpy as unknown as typeof Worktree.create

        const task = await Cortex.launch({
          description: "Failed worktree child",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
          worktree: { create: true, name: "will-fail", baseRef: "current" },
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(createSpy).toHaveBeenCalledTimes(1)
        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("creates the worktree for the child session without binding it before enter", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const mockWt = {
          id: "wt_args_test",
          name: "args-test",
          path: "/tmp/.synergy/worktrees/args-test",
          scopeID: "scope_123",
        }
        const createSpy = mock(async (_input: Worktree.CreateInput) => mockWt)
        const enterSpy = mock(async (_input: Worktree.TargetInput) => mockWt)
        mutableWorktree.create = createSpy as unknown as typeof Worktree.create
        mutableWorktree.enter = enterSpy as unknown as typeof Worktree.enter

        const task = await Cortex.launch({
          description: "Args test",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
          worktree: { create: true, baseRef: "fresh" },
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(createSpy).toHaveBeenCalledTimes(1)
        const createArg = createSpy.mock.calls[0]![0]
        expect(createArg.sessionID).toBe(task!.sessionID)
        expect(createArg.bind).toBe(false)
        expect(createArg.baseRef).toBe("fresh")

        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("cleans a terminal task worktree owned by its child session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const worktreePath = "/tmp/.synergy/worktrees/owned-child"
        let owner: Worktree.Owner | undefined
        const createSpy = mock(async (input: Worktree.CreateInput) => {
          owner = input.sessionID ? { type: "session", sessionID: input.sessionID } : { type: "user" }
          return {
            id: "wt_owned_child",
            name: "owned-child",
            path: worktreePath,
            scopeID: ScopeContext.current.scope.id,
            managed: true,
            owner,
          }
        })
        const enterSpy = mock(async (input: Worktree.TargetInput) => {
          await Session.updateWorkspace(input.sessionID, {
            type: "git_worktree",
            path: worktreePath,
            scopeID: ScopeContext.current.scope.id,
            worktreeID: input.target,
          })
          return {
            id: input.target,
            name: "owned-child",
            path: worktreePath,
            scopeID: ScopeContext.current.scope.id,
            managed: true,
            owner,
          }
        })
        const statusSpy = mock(async (sessionID: string) => ({
          workspace: (await Session.get(sessionID)).workspace,
          worktree: {
            id: "wt_owned_child",
            name: "owned-child",
            path: worktreePath,
            scopeID: ScopeContext.current.scope.id,
            managed: true,
            owner,
          },
          dirty: false,
          path: worktreePath,
        }))
        const removeSpy = mock(async (_input: Worktree.RemoveInput & { sessionID?: string }) => ({
          id: "wt_owned_child",
          name: "owned-child",
          path: worktreePath,
          scopeID: ScopeContext.current.scope.id,
          managed: true,
          owner,
        }))
        mutableWorktree.create = createSpy as unknown as typeof Worktree.create
        mutableWorktree.enter = enterSpy as unknown as typeof Worktree.enter
        mutableWorktree.status = statusSpy as unknown as typeof Worktree.status
        mutableWorktree.remove = removeSpy as unknown as typeof Worktree.remove

        const task = await Cortex.launch({
          description: "Owned worktree cleanup",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
          worktree: { create: true, name: "owned-child", baseRef: "current" },
        })
        expect(owner).toEqual({ type: "session", sessionID: task.sessionID })

        await Cortex.cancel(task.id)
        for (let attempt = 0; attempt < 50 && removeSpy.mock.calls.length === 0; attempt++) {
          await Bun.sleep(10)
        }

        expect(removeSpy).toHaveBeenCalledWith({ sessionID: task.sessionID, target: "wt_owned_child", force: false })
      },
    })
  })
})
