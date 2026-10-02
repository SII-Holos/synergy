import { expect, test } from "bun:test"
import { SessionWorkspaceRuntime } from "../../src/session/workspace-runtime"
import { ExecutionCapacity } from "../../src/session/execution-capacity"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

test("Session binding waits release their lock when execution capacity cannot resume", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await expect(
      ExecutionCapacity.provide(
        "tool",
        {
          pause() {},
          async resume() {
            throw new Error("capacity unavailable")
          },
        },
        () => SessionWorkspaceRuntime.withBinding("same", async () => "unused"),
      ),
    ).rejects.toThrow("capacity unavailable")
    expect(await SessionWorkspaceRuntime.withBinding("same", async () => "acquired", AbortSignal.timeout(500))).toBe(
      "acquired",
    )
  })
})

test("Session binding leases serialize one owner, permit reentrancy and cancel queued requests", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const holding = SessionWorkspaceRuntime.withBinding("same", async () => {
      expect(await SessionWorkspaceRuntime.withBinding("same", async () => "nested")).toBe("nested")
      started.resolve()
      await release.promise
    })
    await started.promise
    expect(await SessionWorkspaceRuntime.withBinding("other", async () => "independent")).toBe("independent")
    const abort = new AbortController()
    let executed = false
    const waiting = SessionWorkspaceRuntime.withBinding(
      "same",
      async () => {
        executed = true
      },
      abort.signal,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    abort.abort(new Error("cancelled binding wait"))
    expect(await waiting).toMatchObject({ message: "cancelled binding wait" })
    expect(executed).toBe(false)
    release.resolve()
    await holding
    expect(await SessionWorkspaceRuntime.withBinding("same", async () => "released")).toBe("released")
  })
})

test("turn admission waits for an in-flight resource selection before reading Session state", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ environmentID: null })
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>()
        const changing = SessionWorkspaceRuntime.withBinding(session.id, async () => {
          entered.resolve()
          await release.promise
          await Session.update(session.id, (draft) => {
            draft.title = "committed selection"
          })
        })
        await entered.promise
        let started = false
        const turn = SessionManager.run(session.id, async () => {
          started = true
          return (await Session.get(session.id)).title
        })
        await Bun.sleep(20)
        expect(started).toBe(false)
        release.resolve()
        await changing
        expect(await turn).toBe("committed selection")
      },
    }),
  )
})
