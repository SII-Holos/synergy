import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { EnvironmentOrigin } from "../../src/environment/origin"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Identifier } from "../../src/id/id"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { EnvironmentExecution } from "../../src/environment/execution"

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

async function nativeSession(environmentID: string) {
  const session = await Session.create({ workspaceID: null, environmentID })
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    rootID,
    isRoot: true,
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: 1 },
  })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    parentID: rootID,
    rootID,
    agent: "general",
    modelID: "fixture",
    providerID: "fixture",
    mode: "default",
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2 },
  })
  const owner = RolloutLifecycle.owner(session)
  await RolloutLedger.beginRun(owner, rootID)
  const callID = "retained-native-admission"
  await RolloutLedger.beginTool({ owner, runID: rootID, messageID, toolCallID: callID, tool: "bash", args: {} })
  return {
    session,
    origin: EnvironmentOrigin.selected({
      kind: "session",
      scopeID: "home",
      sessionID: session.id,
      rootID,
      runID: rootID,
      messageID,
      callID,
      tool: "bash",
    }),
  }
}

test("a native Session admission Use beyond a page blocks freezing while unrelated owners remain live", async () => {
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    register() {
      host = EnvironmentOrigin.registerHost("independent-environment-users")
      EnvironmentProviders.register({
        id: "retained-admission-fixture",
        async allocate(request) {
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "absent" }
        },
        async deallocate() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "session-admission",
          provider: "retained-admission-fixture",
          spec: {},
        })
        const { session, origin } = await nativeSession(environment.id)
        const other = await nativeSession(environment.id)
        const independent: { release(): Promise<void> }[] = []
        if (!host) throw new Error("Independent Environment Host was not composed")
        const hostOrigin = host.capture("independent-uses")
        await Storage.transaction(async () => {
          for (let index = 0; index < 65; index++)
            independent.push(
              await Environment.acquire(environment.id, {
                scopeID: "home",
                useID: `foreign-${String(index).padStart(3, "0")}`,
                ownership: hostOrigin,
                capabilities: ["exec"],
              }),
            )
          independent.push(
            await Environment.acquire(environment.id, {
              scopeID: "home",
              useID: "foreign-session",
              ownership: other.origin,
              capabilities: ["exec"],
            }),
          )
        })
        const use = await Environment.acquire(environment.id, {
          scopeID: "home",
          useID: "retained-session-admission",
          kind: "admission",
          ownership: origin,
          capabilities: ["exec"],
        })
        try {
          expect(await Environment.uses(environment.id)).toHaveLength(67)
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          const binding = {
            sessionID: session.id,
            scopeID: "home",
            handoffID: "held-admission-without-execution",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await expect(Epochs.freeze(binding)).rejects.toMatchObject({ name: "EnvironmentBusy" })
          expect(await Epochs.isFrozen(session.id)).toBe(false)
          expect(await Environment.uses(environment.id)).toHaveLength(67)
          await use.release()
          expect((await Epochs.freeze(binding)).phase).toBe("frozen")
          expect(await Environment.uses(environment.id)).toHaveLength(66)
          expect((await Session.get(other.session.id)).paused).toBeUndefined()
        } finally {
          await use.release()
          await Storage.transaction(async () => {
            for (const use of independent) await use.release()
          })
        }
      },
    }),
  )
})

for (const provenance of ["unknown", "foreign-scope"] as const)
  test(`${provenance} Uses on the selected Environment remain retained and block native freezing`, async () => {
    await using runtime = await testRuntime({
      register() {
        EnvironmentProviders.register({
          id: "legacy-use-fixture",
          async allocate(request) {
            return { id: request.requestID, capabilities: [] }
          },
          async inspect() {
            return { state: "absent" }
          },
          async deallocate() {},
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const environment = await Environment.bind({
            scopeID: "home",
            ownerID: "legacy-selected",
            provider: "legacy-use-fixture",
            spec: {},
          })
          const session = await Session.create({ workspaceID: null, environmentID: environment.id })
          const key = StoragePath.environmentUse(environment.id, "legacy-unknown")
          const legacy = {
            id: "legacy-unknown",
            target: { environmentID: environment.id, allocationID: "original-unknown", generation: 1 },
            createdAt: 1,
            kind: "operation",
          }
          const retained =
            provenance === "unknown"
              ? legacy
              : {
                  schemaVersion: 2,
                  use: {
                    ...legacy,
                    kind: "admission",
                    ownership: {
                      kind: "admission",
                      origin: {
                        kind: "session",
                        scopeID: "foreign-scope",
                        sessionID: "another-session",
                        rootID: "another-root",
                        runID: "another-run",
                        messageID: "another-message",
                        callID: "another-call",
                        tool: "bash",
                      },
                    },
                  },
                }
          await Storage.write(key, retained)
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          await expect(
            Epochs.freeze({
              sessionID: session.id,
              scopeID: "home",
              handoffID: "unknown-environment-use",
              sourceID: "runtime-a",
              targetID: "runtime-b",
              fromEpoch: 1,
              toEpoch: 2,
            }),
          ).rejects.toThrow()
          expect(await Epochs.isFrozen(session.id)).toBe(false)
          expect(await Storage.read(key)).toEqual(retained)
        },
      }),
    )
  })

test("another Session's accepted execution preparation is neither blocked nor consumed by freezing", async () => {
  await using runtime = await testRuntime({
    register() {
      EnvironmentProviders.register({
        id: "pending-foreign-fixture",
        async allocate(request) {
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "absent" }
        },
        async deallocate() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "pending-foreign",
          provider: "pending-foreign-fixture",
          spec: {},
        })
        const source = await Session.create({ environmentID: environment.id, workspaceID: null })
        const other = await nativeSession(environment.id)
        await SessionLifecycle.pause({ sessionID: source.id, reason: "interrupted" })
        const entered = Promise.withResolvers<void>()
        const proceed = Promise.withResolvers<void>()
        const controller = new AbortController()
        const reason = new Error("Original admission owner cancelled its preparation")
        const acquire = Environment.acquire
        using held = spyOn(Environment, "acquire").mockImplementation(async (...args) => {
          const use = await acquire(...args)
          entered.resolve()
          await proceed.promise
          return use
        })
        const pending = EnvironmentExecution.start({
          id: "foreign-preparation",
          scopeID: "home",
          environmentID: environment.id,
          origin: other.origin,
          signal: controller.signal,
          command: { command: "fixture", args: [], cwd: "/fixture", env: {}, useRoots: ["/fixture"] },
        }).then(
          () => ({ completed: true }),
          (error: unknown) => ({ error }),
        )
        try {
          await entered.promise
          expect((await Environment.uses(environment.id))[0]?.ownership.kind).toBe("execution-preparation")
          expect(
            (
              await Epochs.freeze({
                sessionID: source.id,
                scopeID: "home",
                handoffID: "foreign-preparation-handoff",
                sourceID: "runtime-a",
                targetID: "runtime-b",
                fromEpoch: 1,
                toEpoch: 2,
              })
            ).phase,
          ).toBe("frozen")
          expect(controller.signal.aborted).toBe(false)
          expect(await Environment.uses(environment.id)).toHaveLength(1)
        } finally {
          controller.abort(reason)
          proceed.resolve()
          const outcome = await pending
          expect("error" in outcome && outcome.error).toBe(reason)
        }
        expect(await Environment.uses(environment.id)).toEqual([])
      },
    }),
  )
})
