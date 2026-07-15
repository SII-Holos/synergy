import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { enableLightLoop, BlueprintPluginErrorCode } from "../../src/blueprint/plugin-adapter"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("plugin LightLoop Host Service", () => {
  test("exposes and routes enable through lightloop.delegate", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const context = createPluginInvocationContext({
      requestId: "request-lightloop",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 4,
      },
      data: { scopeId: "scope-one", sessionId: "session-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(["lightloop.delegate"]),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
      },
    })

    await context.lightloop?.enable({ taskDescription: "Finish the implementation" })
    expect(calls).toEqual([{ method: "lightloop.enable", params: { taskDescription: "Finish the implementation" } }])
  })

  test("enables LightLoop on an explicit existing Session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const caller = await Session.create({})
        const target = await Session.create({})
        await enableLightLoop({
          scopeId: ScopeContext.current.scope.id,
          sessionId: caller.id,
          request: { sessionID: target.id, taskDescription: "Complete the probe executor" },
        })
        expect((await Session.get(target.id)).workflow).toEqual({
          kind: "lightloop",
          taskDescription: "Complete the probe executor",
        })
        expect((await Session.get(caller.id)).workflow).toBeUndefined()
      },
    })
  })

  test("requires a current or explicit Session", async () => {
    await expect(
      enableLightLoop({ scopeId: "scope-one", request: { taskDescription: "Continue" } }),
    ).rejects.toMatchObject({
      code: BlueprintPluginErrorCode.LIGHTLOOP_SESSION_REQUIRED,
    })

    const context = createPluginInvocationContext({
      requestId: "request-without-capability",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 4,
      },
      data: { scopeId: "scope-one", directory: "/workspace", actor: { type: "lifecycle" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost() {},
    })
    expect(context.lightloop).toBeUndefined()
  })
})
