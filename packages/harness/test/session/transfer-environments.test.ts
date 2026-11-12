import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

test("a selected dormant Environment requires its portability owner before native pause or allocation", async () => {
  let allocations = 0
  await using runtime = await testRuntime({
    register() {
      Core.register()
      EnvironmentProviders.register({
        id: "dormant-environment-fixture",
        ownership: "borrowed",
        async allocate(request) {
          allocations++
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "absent" }
        },
        async deallocate() {},
      })
    },
  })
  const bytes = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, value: Uint8Array) {
      bytes.set(hash, value.slice())
    },
    async get(hash: string, limit: number) {
      const value = bytes.get(hash)
      if (!value || value.length > limit) throw new Error("Missing native transfer fixture content")
      return value.slice()
    },
  }
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: "environment-project",
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: scope.id,
          ownerID: "selected-session",
          provider: "dormant-environment-fixture",
          spec: {},
        })
        const session = await Session.create({ workspaceID: null, environmentID: environment.id })
        await expect(
          Source.prepare({
            binding: {
              sessionID: session.id,
              scopeID: scope.id,
              handoffID: "missing-environment-owner",
              sourceID: "runtime-a",
              targetID: "runtime-b",
              fromEpoch: 1,
              toEpoch: 2,
            },
            store,
            signal: new AbortController().signal,
            async verify() {},
          }),
        ).rejects.toMatchObject({
          data: { requirements: [expect.objectContaining({ code: "owner_missing", owner: "session-environments" })] },
        })
        expect((await Session.get(session.id)).paused).toBeUndefined()
        expect(await Epochs.isFrozen(session.id)).toBe(false)
        expect(await Environment.get(environment.id, scope.id)).toMatchObject({ state: "idle", generation: 0 })
        expect(allocations).toBe(0)
        expect(bytes.size).toBe(0)
      },
    })
  })
}, 15000)
