import "../src/config-schema"
import { afterEach, expect, spyOn, test } from "bun:test"
import { Chronicler } from "../src/chronicler"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const mocks: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

async function fixture(enabled: boolean, run: (ctx: LoopJob.Context, abort: AbortController) => Promise<void>) {
  await using tmp = await tmpdir({ config: { library: { memory: { enabled } } } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "Research" })
      const lastUser = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "synergy",
        model: { providerID: "test", modelID: "test" },
      })
      if (lastUser.role !== "user") throw new Error("expected user")
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: lastUser.id,
        sessionID: session.id,
        type: "text",
        text: "Always record the random seed for experiments.",
      })
      const messages = await Session.messages({ sessionID: session.id })
      const abort = new AbortController()
      const ctx: LoopJob.Context = {
        session,
        sessionID: session.id,
        step: 1,
        messages,
        lastUser,
        lastUserParts: messages[0]!.parts,
        abort: abort.signal,
      }
      Chronicler.register()
      try {
        await run(ctx, abort)
      } finally {
        LoopJob.cancelDetached(session.id)
        await LoopJob.settleDetached(session.id)
      }
    },
  })
}

test("disabled memory never resolves a chronicler model or creates a child execution", async () => {
  const get = spyOn(Agent, "get")
  mocks.push(get)
  await fixture(false, async (ctx) => {
    await LoopJob.execute([{ type: "chronicle" }], ctx)
    await LoopJob.drain(ctx.sessionID)
    expect(get).not.toHaveBeenCalled()
    expect(await Session.children(ctx.sessionID)).toHaveLength(0)
  })
})

test("chronicler persists an unattended child, passes detached conversation and forwards cancellation", async () => {
  mocks.push(spyOn(Agent, "get").mockResolvedValue({ name: "chronicler" } as never))
  mocks.push(spyOn(Agent, "getAvailableModel").mockResolvedValue({ providerID: "test", modelID: "test" }))
  mocks.push(spyOn(Provider, "getModel").mockResolvedValue({ providerID: "test", id: "test" } as never))
  const invoked = Promise.withResolvers<Parameters<typeof SessionInvoke.invokeInternal>[0]>()
  const release = Promise.withResolvers<void>()
  const invoke = spyOn(SessionInvoke, "invokeInternal").mockImplementation(async (input) => {
    invoked.resolve(input)
    await release.promise
    return undefined as never
  })
  const cancel = spyOn(SessionInvoke, "cancel").mockImplementation(() => undefined as never)
  mocks.push(invoke, cancel)
  await fixture(true, async (ctx) => {
    await LoopJob.execute([{ type: "chronicle" }], ctx)
    const input = await Promise.race([
      invoked.promise,
      Bun.sleep(3_000).then(() => {
        throw new Error("chronicler did not invoke")
      }),
    ])
    try {
      expect(input.agent).toBe("chronicler")
      expect(input.origin).toEqual({ type: "system" })
      expect(JSON.stringify(input.parts)).toContain("Always record the random seed")
      const child = await Session.get(input.sessionID)
      expect(child.parentID).toBe(ctx.sessionID)
      expect(child.interaction).toMatchObject({ mode: "unattended", source: "chronicler" })
      expect(child.completionNotice).toMatchObject({ silent: true })
      // Detached runs ignore the loop lease abort; cancellation flows through
      // cancelDetached's own signal.
      LoopJob.cancelDetached(ctx.sessionID)
      expect(cancel).toHaveBeenCalledWith(child.id)
    } finally {
      release.resolve()
      LoopJob.cancelDetached(ctx.sessionID)
      await LoopJob.settleDetached(ctx.sessionID)
    }
    const calls = cancel.mock.calls.length
    LoopJob.cancelDetached(ctx.sessionID)
    expect(cancel.mock.calls).toHaveLength(calls)
  })
})
