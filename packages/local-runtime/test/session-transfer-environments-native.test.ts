import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferEnvironments as Environments,
  SessionTransferStaging as Staging,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
  SessionTransferStream as Stream,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { testRuntime } from "./support/runtime"

function objects() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      const bytes = values.get(hash)
      if (!bytes || bytes.length > maximum) throw new Error("Native Environment fixture object is unavailable")
      return bytes.slice()
    },
  }
}

const register = () => {
  Core.register()
  Environments.register()
}

test("two native Homes map dormant Environments atomically and retain safe evidence while paused", async () => {
  await using temporary = await tmpdir()
  const store = objects()
  const signal = new AbortController().signal
  await using source = await testRuntime({ register })
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "source-session",
          provider: "native",
          spec: {},
        })
        const session = await Session.create({ environmentID: environment.id, workspaceID: null })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "native-environment-selection",
          sourceID: "source-runtime",
          targetID: "target-runtime",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding,
          store,
          signal,
          async verify() {},
        })
        expect(prepared.root.owners["session-environments"]).toBe(3)
        expect(await Environment.get(environment.id, "home")).toMatchObject({ state: "idle", generation: 0 })
        expect((await Session.get(session.id)).paused).toBeDefined()
        return { session: await Session.get(session.id), prepared, binding, environment }
      },
    }),
  )
  await using unavailable = await testRuntime({ register: Core.register })
  await unavailable.run(async () => {
    await expect(
      Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal }),
    ).rejects.toMatchObject({
      data: { requirements: [expect.objectContaining({ code: "owner_missing", owner: "session-environments" })] },
    })
    await expect(Staging.inspect(captured.binding.handoffID)).rejects.toThrow()
  })
  const destinationHome = path.join(temporary.path, "destination")
  await using destination = await testRuntime({ register, home: destinationHome })
  const installed = await destination.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "target-native",
          provider: "native",
          spec: {},
        })
        await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
        const core = await Staging.context({
          handoffID: captured.binding.handoffID,
          rootSessionID: captured.session.id,
          session: captured.session,
          ownerID: "session-core",
          signal,
          mapping: { environmentID: environment.id },
        })
        const context = await Staging.context({
          handoffID: captured.binding.handoffID,
          rootSessionID: captured.session.id,
          session: captured.session,
          ownerID: "session-environments",
          signal,
          mapping: { environmentID: environment.id },
        })
        const invalidMappings: Owners.TargetContext["mapping"][] = [
          {},
          { environmentID: null },
          { environmentID: captured.environment.id },
        ]
        for (const mapping of invalidMappings)
          await expect(Owners.validate("session-environments", { ...context, mapping })).rejects.toThrow()
        await (async () => {
          const provider = EnvironmentProviders.get("native")
          if (!provider.portableDescriptor) throw new Error("Native provider must supply its descriptor")
          const original = provider.portableDescriptor({})
          using incompatible = spyOn(provider, "portableDescriptor").mockReturnValue({
            ...original,
            architecture: "incompatible-architecture",
          })
          await expect(Owners.validate("session-environments", context)).rejects.toThrow("incompatible")
        })()
        const foreign = await Environment.bind({
          scopeID: "other-scope",
          ownerID: "foreign-native",
          provider: "native",
          spec: {},
        })
        await expect(
          Owners.validate("session-environments", { ...context, mapping: { environmentID: foreign.id } }),
        ).rejects.toThrow("Scope")
        await expect(
          Owners.validate("session-environments", {
            ...context,
            session: { ...context.session, environmentID: null },
            mapping: { environmentID: null },
            staged: {
              ...context.staged,
              async *records() {
                for await (const row of context.staged.records())
                  yield { ...row, value: { ...z.record(z.string(), z.unknown()).parse(row.value), selected: null } }
              },
            },
          }),
        ).rejects.toThrow("canonical Core selection")
        await Owners.validate("session-core", core)
        await Owners.validate("session-environments", context)
        expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
        expect(
          await Environments.receipt({
            scopeID: "home",
            sessionID: captured.session.id,
            handoffID: captured.binding.handoffID,
          }),
        ).toBeUndefined()
        await expect(Session.get(captured.session.id)).rejects.toThrow()
        await Epochs.reserve(captured.binding, captured.prepared.manifestHash)
        const contexts = [
          { ownerID: "session-core", context: core },
          { ownerID: "session-environments", context },
        ]
        const failure = new Error("actual activation rollback")
        await expect(
          Epochs.activate(captured.binding, captured.prepared.manifestHash, async () => {
            await Staging.publish({ handoffID: captured.binding.handoffID, contexts })
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
        expect(
          await Environments.receipt({
            scopeID: "home",
            sessionID: captured.session.id,
            handoffID: captured.binding.handoffID,
          }),
        ).toBeUndefined()
        await expect(Session.get(captured.session.id)).rejects.toThrow()
        await Epochs.activate(captured.binding, captured.prepared.manifestHash, () =>
          Staging.publish({ handoffID: captured.binding.handoffID, contexts }),
        )
        expect((await Session.get(captured.session.id)).environmentID).toBe(environment.id)
        expect((await Session.get(captured.session.id)).paused).toBeDefined()
        expect((await Environment.binding("home", captured.session.id))?.id).toBe(environment.id)
        expect(await Environment.get(environment.id, "home")).toMatchObject({ state: "idle", generation: 0, spec: {} })
        const receipt = await Environments.receipt({
          scopeID: "home",
          sessionID: captured.session.id,
          handoffID: captured.binding.handoffID,
        })
        expect(receipt).toMatchObject({
          source: { selected: { environmentID: captured.environment.id, state: "idle" } },
          target: { environmentID: environment.id, generation: 0 },
        })
        expect(Object.keys(receipt?.source.selected ?? {}).sort()).toEqual([
          "descriptor",
          "environmentID",
          "generation",
          "provider",
          "state",
        ])
        expect(Object.keys(receipt?.target?.descriptor ?? {}).sort()).toEqual([
          "architecture",
          "capabilities",
          "kind",
          "platform",
          "version",
        ])
        return { environment, receipt }
      },
    }),
  )
  await destination.close()
  await using cold = await testRuntime({ register, home: destinationHome })
  await cold.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        expect(
          await Environments.receipt({
            scopeID: "home",
            sessionID: captured.session.id,
            handoffID: captured.binding.handoffID,
          }),
        ).toEqual(installed.receipt)
        expect((await Environment.binding("home", captured.session.id))?.id).toBe(installed.environment.id)
        const prepared = await Source.prepare({
          binding: {
            ...captured.binding,
            sourceID: captured.binding.targetID,
            targetID: "third-runtime",
            handoffID: "cold-native-selection",
            fromEpoch: 2,
            toEpoch: 3,
          },
          store,
          signal,
          async verify() {},
        })
        await using reader = await Stream.open({ root: prepared.root, store, directory: cold.host.root, signal })
        const retained: unknown[] = []
        for await (const item of reader.entries()) {
          const chunks: Uint8Array[] = []
          for await (const chunk of item.content) chunks.push(chunk)
          if (item.metadata.transferOwner === "session-environments")
            retained.push(JSON.parse(Buffer.concat(chunks).toString()))
        }
        expect(retained).toHaveLength(2)
        expect(retained).toContainEqual(installed.receipt)
        expect(retained).toContainEqual(
          expect.objectContaining({
            kind: "source",
            handoffID: "cold-native-selection",
            selected: expect.objectContaining({ environmentID: installed.environment.id }),
          }),
        )
        expect((await Environment.get(installed.environment.id, "home")).state).toBe("idle")
      },
    }),
  )
}, 15_000)

test("native provider rejects a private spec before pausing or allocating its selected Environment", async () => {
  await using runtime = await testRuntime({ register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "private-spec",
          provider: "native",
          spec: {},
        })
        const session = await Session.create({ workspaceID: null, environmentID: environment.id })
        await Storage.write(["environment", environment.id], {
          ...environment,
          spec: { privateToken: "fixture-secret" },
        })
        await expect(
          Source.prepare({
            binding: {
              scopeID: "home",
              sessionID: session.id,
              handoffID: "private-native-spec",
              sourceID: "A",
              targetID: "B",
              fromEpoch: 1,
              toEpoch: 2,
            },
            store: objects(),
            signal: new AbortController().signal,
            async verify() {},
          }),
        ).rejects.toMatchObject({
          data: {
            requirements: [
              expect.objectContaining({ code: "environment_portability_unavailable", owner: "session-environments" }),
            ],
          },
        })
        expect((await Session.get(session.id)).paused).toBeUndefined()
        expect((await Environment.get(environment.id, "home")).state).toBe("idle")
        expect(await Epochs.isFrozen(session.id)).toBe(false)
      },
    }),
  )
}, 15_000)

test("an inconsistent terminal native receipt remains intact and blocks history transfer", async () => {
  await using runtime = await testRuntime({ register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "historical-native",
          provider: "native",
          spec: {},
        })
        const session = await Session.create({ workspaceID: null, environmentID: environment.id })
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
        await RolloutLedger.beginTool({
          owner,
          runID: rootID,
          messageID,
          toolCallID: "historical-native-call",
          tool: "bash",
          args: {},
        })
        const origin = EnvironmentOrigin.selected({
          kind: "session",
          scopeID: "home",
          sessionID: session.id,
          rootID,
          runID: rootID,
          messageID,
          callID: "historical-native-call",
          tool: "bash",
        })
        let execution = await EnvironmentExecution.start({
          id: "native-historical-operation",
          scopeID: "home",
          environmentID: environment.id,
          origin,
          command: {
            command: process.execPath,
            args: ["-e", "process.stdout.write('retained native history')"],
            cwd: runtime.host.root,
            env: {},
            useRoots: [],
          },
        })
        for (let attempt = 0; execution.state !== "exited" && attempt < 300; attempt++) {
          await Bun.sleep(10)
          execution = await EnvironmentExecution.reconcile(execution.id, "home")
        }
        expect(execution.state).toBe("exited")
        await EnvironmentExecution.complete(execution.id, "home")
        const before = await EnvironmentExecution.get(execution.id, "home")
        expect(before.state).toBe("completed")
        const key = ["environment_execution", "home", execution.id]
        const raw = z.record(z.string(), z.unknown()).parse(await Storage.read(key))
        const corrupted = { ...raw, execution: { ...before, status: { ...before.status, streamsDrained: false } } }
        await Storage.write(key, corrupted)
        await expect(
          Source.prepare({
            binding: {
              scopeID: "home",
              sessionID: session.id,
              handoffID: "native-history-needs-reader",
              sourceID: "A",
              targetID: "B",
              fromEpoch: 1,
              toEpoch: 2,
            },
            store: objects(),
            signal: new AbortController().signal,
            async verify() {},
          }),
        ).rejects.toMatchObject({
          data: {
            requirements: [
              expect.objectContaining({
                code: "environment_portability_unavailable",
              }),
            ],
          },
        })
        expect(await Storage.read(key)).toEqual(corrupted)
        expect((await Session.get(session.id)).paused).toBeUndefined()
        expect(
          (await EnvironmentExecution.output(execution.id, "home"))
            .map((chunk) => Buffer.from(chunk.data, "base64").toString())
            .join(""),
        ).toBe("retained native history")
        expect(await Environment.uses(environment.id)).toEqual([])
      },
    }),
  )
}, 15_000)

test("a registered Environment mapping callback owns publication while retained facts remain inert", async () => {
  const store = objects()
  const signal = new AbortController().signal
  const frames = RuntimeContext.createAsyncContext<{ open: boolean; assert(): void }>()
  const hash = "a".repeat(64)
  let originalID: string | undefined
  let expectedMapping: NonNullable<ReturnType<Environments.MappingSource["capture"]>>["mapping"] | undefined
  const frame = () => {
    const runtime = RuntimeContext.current(), current = Storage.current(), namespace = JSON.stringify(current.store.options)
    const owner: { open: boolean; assert(): void } = {
      open: true,
      assert() {
        const selected = Storage.current()
        if (!owner.open || frames.getStore() !== owner || RuntimeContext.current() !== runtime || selected.store !== current.store || JSON.stringify(selected.store.options) !== namespace || selected.artifactDirectory !== current.artifactDirectory || selected.artifactObjects !== current.artifactObjects)
          throw new Error("Original Environment mapping callback has ended or changed its namespace")
      },
    }
    return owner
  }
  const authority = () => {
    const owner = frames.getStore()
    if (!owner) throw new Error("Explicit Environment mapping has no original callback")
    owner.assert()
    return owner
  }
  await using source = await testRuntime({
    register() {
      register()
      Environments.registerMappingSource("logical-transfer-fixture", {
        applies: (session) => session.id === originalID,
        capture(context, selected) {
          const owner = authority()
          if (!selected || context.session.id !== originalID || context.handoffID !== "explicit-native-transition")
            throw new Error("Original native source mapping changed")
          expectedMapping = {
            version: 1,
            provider: "logical-transfer-fixture",
            hash,
            source: { kind: "native", environmentID: selected.environmentID, descriptor: selected.descriptor },
            target: { kind: "retained-logical-fixture", resourceID: "selected-resource" },
          }
          return { mapping: expectedMapping, assert: owner.assert.bind(owner) }
        },
        target() { throw new Error("The source callback cannot publish a target") },
      })
    },
  })
  const captured = await source.run(() => ScopeContext.provide({
    scope: Scope.home(), workspace: null,
    fn: async () => {
      using allocation = spyOn(EnvironmentProviders.get("native"), "allocate")
      const environment = await Environment.bind({ scopeID: "home", ownerID: "logical-source", provider: "native", spec: {} })
      const session = await Session.create({ environmentID: environment.id, workspaceID: null })
      originalID = session.id
      const binding = { scopeID: "home", sessionID: session.id, handoffID: "explicit-native-transition", sourceID: "source-runtime", targetID: "target-runtime", fromEpoch: 1, toEpoch: 2 }
      const owner = frame()
      try {
        const prepared = await frames.run(owner, () => Source.prepare({ binding, store, signal, async verify() {} }))
        expect(prepared.root.owners["session-environments"]).toBe(3)
        expect(allocation).not.toHaveBeenCalled()
        expect(await Environment.get(environment.id, "home")).toMatchObject({ state: "idle", generation: 0 })
        return { binding, prepared, session: await Session.get(session.id), environment }
      } finally { owner.open = false }
    },
  }))
  await using target = await testRuntime({
    register() {
      register()
      Environments.registerMappingSource("logical-transfer-fixture", {
        applies: () => false,
        capture: () => undefined,
        target(context, source, selected) {
          const owner = authority()
          if (selected !== null || source.mapping.hash !== hash || context.mapping.environmentMappingHash !== hash || JSON.stringify(source.mapping) !== JSON.stringify(expectedMapping))
            throw new Error("The explicit target changed its original mapping")
          return owner.assert.bind(owner)
        },
      })
    },
  })
  await target.run(() => ScopeContext.provide({
    scope: Scope.home(), workspace: null,
    fn: async () => {
      using allocation = spyOn(EnvironmentProviders.get("native"), "allocate")
      await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
      const input = { handoffID: captured.binding.handoffID, rootSessionID: captured.session.id, session: captured.session, signal, mapping: { environmentID: null, environmentMappingHash: hash } }
      const core = await Staging.context({ ...input, ownerID: "session-core" })
      const context = await Staging.context({ ...input, ownerID: "session-environments" })
      await expect(Owners.validate("session-environments", context)).rejects.toThrow("original callback")
      await Owners.validate("session-core", core)
      await Epochs.reserve(captured.binding, captured.prepared.manifestHash)
      const contexts = [{ ownerID: "session-core", context: core }, { ownerID: "session-environments", context }]
      const ended = frame()
      await frames.run(ended, async () => {
        await Owners.validate("session-environments", context)
        await expect(Epochs.activate(captured.binding, captured.prepared.manifestHash, async () => {
          await Staging.publish({ handoffID: captured.binding.handoffID, contexts })
          ended.open = false
        })).rejects.toThrow("callback has ended")
      })
      expect(await Environments.receipt(captured.binding)).toBeUndefined()
      await expect(Session.get(captured.session.id)).rejects.toThrow()
      expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
      const freshCore = await Staging.context({ ...input, ownerID: "session-core" })
      const freshContext = await Staging.context({ ...input, ownerID: "session-environments" })
      const freshContexts = [{ ownerID: "session-core", context: freshCore }, { ownerID: "session-environments", context: freshContext }]
      const current = frame()
      try {
        await frames.run(current, async () => {
          await Owners.validate("session-core", freshCore)
          await Owners.validate("session-environments", freshContext)
          await Epochs.activate(captured.binding, captured.prepared.manifestHash, () => Staging.publish({ handoffID: captured.binding.handoffID, contexts: freshContexts }))
        })
      } finally { current.open = false }
      const receipt = await Environments.receipt(captured.binding)
      expect(receipt).toMatchObject({ version: 3, source: { selected: { environmentID: captured.environment.id }, mapping: expectedMapping }, target: null })
      expect((await Session.get(captured.session.id)).environmentID).toBeNull()
      expect((await Session.get(captured.session.id)).paused).toBeDefined()
      expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
      expect(allocation).not.toHaveBeenCalled()
      await expect(Owners.validate("session-environments", freshContext)).rejects.toThrow("callback")
      expect(await Environments.receipt(captured.binding)).toEqual(receipt)
    },
  }))
})
