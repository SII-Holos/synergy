import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentExecution } from "../../src/environment/execution"
import { EnvironmentProviders } from "../../src/environment/provider"
import { type ExecutionProtocol, type Executor } from "../../src/environment/executor"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"
import { EnvironmentExecutionSchema } from "../../src/environment/execution-schema"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { MigrationRegistry } from "../../src/migration/registry"
import { environmentMigrations } from "../../src/environment/migration"
import { executionOriginPhysicalMigration } from "../../src/environment/execution-origin-migration"
import { executionSourcePhysicalMigration } from "../../src/environment/execution-source-migration"
import { tmpdir } from "../support/fixture"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs } from "../../src/session/transfer-epochs"
import { TransactionalStore } from "../../src/storage/transactional-store"
import path from "node:path"
import { EnvironmentResources } from "../../src/environment/resources"
import { SessionTransferOwners } from "../../src/session/transfer-owners"

async function fixture(
  options: {
    home?: string
    legacyStorage?: boolean
    allocate?: () => Promise<void>
    connect?: () => Promise<void>
  } = {},
) {
  let starts = 0
  const operations = new Map<string, ExecutionProtocol.Status>()
  const executor: Executor = {
    async start(input) {
      starts++
      const status: ExecutionProtocol.Status = {
        id: input.id,
        target: input.target,
        digest: input.digest,
        state: "exited",
        exitCode: 0,
        cursor: 0,
        treeDrained: true,
        streamsDrained: true,
      }
      operations.set(input.id, status)
      return status
    },
    async status(id) {
      return operations.get(id)
    },
    async output() {
      return []
    },
    async stdin() {},
    async resize() {},
    async cancel() {},
    async release() {},
  }
  const runtime = await testRuntime({
    home: options.home,
    register() {
      if (options.legacyStorage) {
        MigrationRegistry.unregister("environment")
        MigrationRegistry.register(
          "environment",
          environmentMigrations.filter(
            (migration) =>
              migration.id !== executionOriginPhysicalMigration.id &&
              migration.id !== executionSourcePhysicalMigration.id,
          ),
        )
      }
      EnvironmentProviders.register({
        id: "origin-fixture",
        async allocate(request) {
          await options.allocate?.()
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: ["exec"] } }
        },
        async deallocate() {},
        async connect(_request, target) {
          await options.connect?.()
          return {
            ...executor,
            async describe() {
              return { target, platform: "linux", arch: "x64", shell: "/bin/sh", directory: "/workspace", env: {} }
            },
          }
        },
      })
    },
  })
  try {
    const input = await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const environment = await Environment.bind({
            scopeID: "home",
            ownerID: "owner",
            provider: "origin-fixture",
            spec: {},
          })
          const session = await Session.create({ environmentID: environment.id, workspaceID: null })
          const rootID = Identifier.ascending("message")
          await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            time: { created: 1 },
            rootID,
            isRoot: true,
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
          })
          const owner = RolloutLifecycle.owner(session)
          await RolloutLedger.beginRun(owner, rootID)
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
            time: { created: 2 },
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const origin = {
            kind: "session" as const,
            scopeID: "home",
            sessionID: session.id,
            rootID,
            runID: rootID,
            messageID,
            callID: "tool-call",
            tool: "bash",
          }
          await RolloutLedger.beginTool({
            owner,
            runID: rootID,
            messageID,
            toolCallID: origin.callID,
            tool: "bash",
            args: { command: "example" },
          })
          return {
            id: "operation",
            scopeID: "home",
            environmentID: environment.id,
            origin,
            command: { command: "example", args: [], cwd: "/workspace", env: {}, useRoots: ["/workspace"] },
          }
        },
      }),
    )
    return { runtime, input, starts: () => starts, [Symbol.asyncDispose]: () => runtime.close() }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

test("Environment execution retains the canonical native Session/root/tool origin", async () => {
  await using f = await fixture()
  await f.runtime.run(async () => {
    const result = await EnvironmentExecution.start(f.input)
    try {
      expect(result).toMatchObject({ origin: f.input.origin })
      expect(await EnvironmentExecution.get(f.input.id, f.input.scopeID)).toMatchObject({ origin: f.input.origin })
      expect(f.starts()).toBe(1)
    } finally {
      await EnvironmentExecution.complete(f.input.id, f.input.scopeID, async () => ({ saved: {} }))
    }
  })
})

test("final Session freeze cannot pass a real accepted Environment allocation before its receipt exists", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    allocate: async () => {
      entered.resolve()
      await release.promise
    },
  })
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const started = EnvironmentExecution.start(f.input)
        const result = started.then(
          () => "started",
          () => "refused",
        )
        await entered.promise
        const binding = {
          sessionID: f.input.origin.sessionID,
          scopeID: "home",
          handoffID: "pending-allocation",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        try {
          await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
          await SessionTransferEpochs.beginSource(binding)
          await expect(SessionTransferEpochs.freeze(binding)).rejects.toThrow("Environment")
          expect((await SessionTransferEpochs.inspect(binding)).phase).toBe("draining")
          expect(f.starts()).toBe(0)
          release.resolve()
          expect(await result).toBe("refused")
          await SessionTransferEpochs.freeze(binding)
          expect((await SessionTransferEpochs.inspect(binding)).phase).toBe("frozen")
        } finally {
          release.resolve()
          await result
        }
      },
    }),
  )
})

test("an existing operation identity cannot be reused under a different native root", async () => {
  await using f = await fixture()
  await f.runtime.run(async () => {
    await EnvironmentExecution.start(f.input)
    try {
      await expect(
        EnvironmentExecution.start({
          ...f.input,
          origin: { ...f.input.origin, rootID: Identifier.ascending("message") },
        }),
      ).rejects.toThrow("different input")
      expect(f.starts()).toBe(1)
      expect(await Environment.uses(f.input.environmentID)).toHaveLength(1)
    } finally {
      await EnvironmentExecution.complete(f.input.id, f.input.scopeID, async () => ({ saved: {} }))
    }
  })
})

test("current execution storage fences the actual legacy reader before it can discard ownership", async () => {
  await using f = await fixture()
  await f.runtime.run(async () => {
    await EnvironmentExecution.start(f.input)
    try {
      const raw = await Storage.read(StoragePath.environmentExecution(f.input.scopeID, f.input.id))
      expect(EnvironmentExecutionSchema.LegacyInfo.safeParse(raw).success).toBeFalse()
      expect(EnvironmentExecutionSchema.Record.parse(raw)).toMatchObject({
        schemaVersion: 2,
        execution: { origin: f.input.origin },
      })
    } finally {
      await EnvironmentExecution.complete(f.input.id, f.input.scopeID, async () => ({ saved: {} }))
    }
  })
})

test("a native tool origin cannot allocate another Environment in the same Scope", async () => {
  await using f = await fixture()
  await f.runtime.run(async () => {
    const other = await Environment.bind({ scopeID: "home", ownerID: "other", provider: "origin-fixture", spec: {} })
    const result = await EnvironmentExecution.start({
      ...f.input,
      id: "other-environment",
      environmentID: other.id,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      expect(result).toHaveProperty("error")
      expect(await Environment.get(other.id, "home")).toMatchObject({ state: "idle", generation: 0 })
      expect(f.starts()).toBe(0)
    } finally {
      if ("value" in result) await EnvironmentExecution.complete(result.value.id, "home", async () => ({ saved: {} }))
    }
  })
})

test("central migration physically fences legacy receipts without guessing origin or replaying history", async () => {
  await using home = await tmpdir()
  await using f = await fixture({ home: home.path, legacyStorage: true })
  const key = StoragePath.environmentExecution(f.input.scopeID, f.input.id)
  const legacy = await f.runtime.run(async () => {
    await EnvironmentExecution.start(f.input)
    await EnvironmentExecution.complete(f.input.id, f.input.scopeID, async () => ({ saved: {} }))
    const { origin: _, ...execution } = EnvironmentExecutionSchema.Record.parse(await Storage.read(key)).execution
    const previous = { ...execution, futureExecutionOwner: { nested: { unchanged: ["owner-evidence"] } } }
    expect(EnvironmentExecutionSchema.LegacyInfo.safeParse(previous).success).toBeTrue()
    await Storage.write(key, previous)
    return previous
  })
  await f.runtime.close()
  await using cold = await testRuntime({ home: home.path })
  await cold.run(async () => {
    const raw = await Storage.read(key)
    expect(raw).toEqual({ schemaVersion: 2, execution: { ...legacy, origin: { kind: "legacy-unknown" } } })
    expect(EnvironmentExecutionSchema.LegacyInfo.safeParse(raw).success).toBeFalse()
    const info = await EnvironmentExecution.get(f.input.id, f.input.scopeID)
    expect(info).toMatchObject({ state: "completed", origin: { kind: "legacy-unknown" } })
    expect(info).not.toHaveProperty("futureExecutionOwner")
    expect(f.starts()).toBe(1)
    await Storage.write(key, { schemaVersion: 3, execution: { ...legacy, origin: { kind: "legacy-unknown" } } })
    await expect(EnvironmentExecution.get(f.input.id, f.input.scopeID)).rejects.toThrow()
  })
})

test("native Session drainage waits for the accepted provider request and observer cancellation does not stop it", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    allocate: async () => {
      entered.resolve()
      await release.promise
    },
  })
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const result = EnvironmentExecution.start(f.input).then(
          () => "started",
          () => "refused",
        )
        await entered.promise
        const binding = {
          sessionID: f.input.origin.sessionID,
          scopeID: "home",
          handoffID: "drain-pending",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const controller = new AbortController()
        const reason = new Error("observer stopped waiting")
        try {
          await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
          await SessionTransferEpochs.beginSource(binding)
          const drained = EnvironmentExecution.drainSession({
            scopeID: "home",
            sessionID: binding.sessionID,
            signal: controller.signal,
          })
          controller.abort(reason)
          await expect(drained).rejects.toBe(reason)
          expect(EnvironmentExecution.hasSessionPending("home", binding.sessionID)).toBeTrue()
          await expect(SessionTransferEpochs.freeze(binding)).rejects.toThrow("Environment")
          release.resolve()
          expect(await result).toBe("refused")
          await EnvironmentExecution.drainSession({
            scopeID: "home",
            sessionID: binding.sessionID,
            signal: new AbortController().signal,
          })
          await SessionTransferEpochs.freeze(binding)
          expect(f.starts()).toBe(0)
        } finally {
          release.resolve()
          await result
        }
      },
    }),
  )
})

test("Session operation discovery retains historical origin after Environment deselection and rechecks the canonical locator", async () => {
  await using f = await fixture()
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await EnvironmentExecution.start(f.input)
        await EnvironmentExecution.complete(f.input.id, "home", async () => ({ saved: {} }))
        await Session.updateEnvironment(f.input.origin.sessionID, {
          environmentID: null,
          expectedEnvironmentID: f.input.environmentID,
        })
        const entries = []
        for await (const info of EnvironmentExecution.sessionEntries({
          scopeID: "home",
          sessionID: f.input.origin.sessionID,
        }))
          entries.push(info)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ id: f.input.id, origin: f.input.origin, state: "completed" })
        await expect(
          SessionTransferOwners.selected({
            session: await Session.get(f.input.origin.sessionID),
            rootSessionID: f.input.origin.sessionID,
            handoffID: "historical-environment",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ data: { requirements: [{ code: "owner_missing", owner: "session-environments" }] } })
        expect((await Session.get(f.input.origin.sessionID)).paused).toBeUndefined()
        const other = await Session.create({ environmentID: null, workspaceID: null })
        const unrelated = []
        for await (const info of EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: other.id }))
          unrelated.push(info)
        expect(unrelated).toEqual([])
        await Storage.write(["environment_execution_session", "home", other.id, f.input.origin.rootID, f.input.id], {
          version: 1,
          scopeID: "home",
          operationID: f.input.id,
        })
        await expect(
          (async () => {
            for await (const _ of EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: other.id })) {
            }
          })(),
        ).rejects.toThrow("canonical owner")
      },
    }),
  )
})

test("missing origin-index coverage cannot turn existing native history into proof of an empty Session", async () => {
  await using f = await fixture({ legacyStorage: true })
  await f.runtime.run(async () => {
    await EnvironmentExecution.start(f.input)
    await EnvironmentExecution.complete(f.input.id, "home", async () => ({ saved: {} }))
    await expect(EnvironmentExecution.assertSessionDrained("home", f.input.origin.sessionID)).rejects.toThrow(
      "owning migration",
    )
  })
})

test("cold active legacy operations block their selected Environment without acquiring another Session's history", async () => {
  await using home = await tmpdir()
  await using f = await fixture({ home: home.path, legacyStorage: true })
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await EnvironmentExecution.start(f.input)
        const key = StoragePath.environmentExecution("home", f.input.id)
        const { origin: _, ...legacy } = EnvironmentExecutionSchema.Record.parse(await Storage.read(key)).execution
        await Storage.write(key, legacy)
        await SessionLifecycle.pause({ sessionID: f.input.origin.sessionID, reason: "interrupted" })
      },
    }),
  )
  await f.runtime.close()
  await using cold = await testRuntime({ home: home.path })
  await cold.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const binding = {
          sessionID: f.input.origin.sessionID,
          scopeID: "home",
          handoffID: "legacy-active",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await SessionTransferEpochs.beginSource(binding)
        await expect(SessionTransferEpochs.freeze(binding)).rejects.toThrow("unknown Session ownership")
        expect((await SessionTransferEpochs.inspect(binding)).phase).toBe("draining")
        const history = []
        for await (const info of EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: binding.sessionID }))
          history.push(info)
        expect(history).toEqual([])
        expect(await EnvironmentExecution.get(f.input.id, "home")).toMatchObject({ origin: { kind: "legacy-unknown" } })
        expect(f.starts()).toBe(1)
      },
    }),
  )
})

test("pending Session execution and deferred index iterators stay bound to their actual Store", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using f = await fixture({
    allocate: async () => {
      entered.resolve()
      await release.promise
    },
  })
  await using directory = await tmpdir()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory.path, "foreign.sqlite"),
    namespace: "foreign",
  })
  try {
    await f.runtime.run(async () => {
      const iterator = EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: f.input.origin.sessionID })[
        Symbol.asyncIterator
      ]()
      const pending = EnvironmentExecution.start(f.input)
      await entered.promise
      const rescue = setTimeout(() => release.resolve(), 500)
      try {
        await Storage.provide({ store: foreign, artifactDirectory: directory.path }, async () => {
          expect(EnvironmentExecution.hasSessionPending("home", f.input.origin.sessionID)).toBeFalse()
          await expect(EnvironmentExecution.start(f.input)).rejects.toThrow("canonical Session")
          await expect(iterator.next()).rejects.toThrow("Storage handle")
          expect(await Storage.list(["environment_execution"])).toEqual([])
        })
      } finally {
        clearTimeout(rescue)
        release.resolve()
        await pending
        await EnvironmentExecution.complete(f.input.id, "home", async () => ({ saved: {} }))
      }
    })
  } finally {
    release.resolve()
    await foreign.close()
  }
})

test.each(["allocate", "connect"] as const)(
  "native resource %s preparation remains visible before an Execution receipt and rechecks paused admission",
  async (stage) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await using f = await fixture({
      [stage]: async () => {
        entered.resolve()
        await release.promise
      },
    })
    await f.runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const preparation = EnvironmentResources.resolve({
            origin: f.input.origin,
            scopeID: "home",
            environmentID: f.input.environmentID,
            workspaceID: null,
            needs: { execution: "exec" },
          }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await entered.promise
          const binding = {
            sessionID: f.input.origin.sessionID,
            scopeID: "home",
            handoffID: "resources-" + stage,
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          try {
            expect(await Storage.list(["environment_execution"])).toEqual([])
            await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
            await SessionTransferEpochs.beginSource(binding)
            await expect(SessionTransferEpochs.freeze(binding)).rejects.toThrow("Environment")
            release.resolve()
            const result = await preparation
            if ("value" in result) await result.value.release()
            expect(result).toHaveProperty("error")
            expect(await Environment.uses(f.input.environmentID)).toEqual([])
            expect(f.starts()).toBe(0)
            await SessionTransferEpochs.freeze(binding)
          } finally {
            release.resolve()
            const result = await preparation
            if ("value" in result) await result.value.release()
          }
        },
      }),
    )
  },
)

test("an unknown allocation cannot become a drained Session merely because its original request rejected", async () => {
  await using f = await fixture({
    allocate: async () => {
      throw new Error("allocation acknowledgement lost")
    },
  })
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await expect(EnvironmentExecution.start(f.input)).rejects.toThrow("acknowledgement lost")
        expect(EnvironmentExecution.hasSessionPending("home", f.input.origin.sessionID)).toBeFalse()
        expect(await Environment.get(f.input.environmentID, "home")).toMatchObject({ state: "allocating" })
        const binding = {
          sessionID: f.input.origin.sessionID,
          scopeID: "home",
          handoffID: "unknown-allocation",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
        await SessionTransferEpochs.beginSource(binding)
        await expect(SessionTransferEpochs.freeze(binding)).rejects.toThrow("allocation")
        expect((await SessionTransferEpochs.inspect(binding)).phase).toBe("draining")
        expect(f.starts()).toBe(0)
      },
    }),
  )
})
