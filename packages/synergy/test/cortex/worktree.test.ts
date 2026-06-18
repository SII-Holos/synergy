import { describe, expect, test, mock, afterEach } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { Worktree } from "../../src/project/worktree"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// cortex/worktree.test.ts
//
// Tests for Cortex.launch worktree-related behavior verified via mock spies:
//   1. Worktree.create called when worktree.create input is provided
//   2. Worktree.enter called to bind the child session after creation
//   3. Worktree NOT called when worktree.create not in input
//   4. Task survives failed worktree creation gracefully
// ---------------------------------------------------------------------------

const _origWorktree = {
  create: Worktree.create,
  enter: Worktree.enter,
}

afterEach(() => {
  Cortex.reset()
  ;(Worktree as any).create = _origWorktree.create
  ;(Worktree as any).enter = _origWorktree.enter
})

describe("Cortex worktree creation", () => {
  test("calls Worktree.create and Worktree.enter when worktree.create is requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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
        const createSpy = mock(async () => mockWt)
        const enterSpy = mock(async () => mockWt)
        ;(Worktree as any).create = createSpy
        ;(Worktree as any).enter = enterSpy

        const task = await Cortex.launch({
          description: "Create worktree child",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
          worktree: { create: true, name: "child-worktree", baseRef: "current" },
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(createSpy).toHaveBeenCalledTimes(1)
        const createArg = (createSpy as any).mock.calls[0][0]
        expect(createArg.name).toBe("child-worktree")
        expect(createArg.baseRef).toBe("current")

        expect(enterSpy).toHaveBeenCalledTimes(1)
        const enterArg = (enterSpy as any).mock.calls[0][0]
        expect(enterArg.target).toBe("wt_child_test")
        expect(enterArg.sessionID).toBe(task!.sessionID)

        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("does not create worktree when worktree.create is not requested", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const createSpy = mock(async () => ({}) as any)
        ;(Worktree as any).create = createSpy

        const task = await Cortex.launch({
          description: "No worktree child",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_test01234567890abc",
        }).catch(() => undefined)

        expect(task).toBeDefined()
        expect(createSpy).not.toHaveBeenCalled()
        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })

  test("survives failed worktree creation gracefully", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const createSpy = mock(async () => {
          throw new Worktree.CreateFailedError({ message: "Disk full" })
        })
        ;(Worktree as any).create = createSpy

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

  test("passes bind:false and correct args to Worktree.create", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})
        const mockWt = {
          id: "wt_args_test",
          name: "args-test",
          path: "/tmp/.synergy/worktrees/args-test",
          scopeID: "scope_123",
        }
        const createSpy = mock(async () => mockWt)
        const enterSpy = mock(async () => mockWt)
        ;(Worktree as any).create = createSpy
        ;(Worktree as any).enter = enterSpy

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
        const createArg = (createSpy as any).mock.calls[0][0]
        // bind:false because Cortex manages binding via enter()
        expect(createArg.bind).toBe(false)
        // baseRef forwarded from launch input
        expect(createArg.baseRef).toBe("fresh")

        await Cortex.cancel(task!.id).catch(() => {})
      },
    })
  })
})
