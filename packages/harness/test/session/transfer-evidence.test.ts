import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Asset } from "../../src/asset/asset"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Identifier } from "../../src/id/id"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferEvidence as Evidence } from "../../src/session/transfer-evidence"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { StoredToolOutput } from "../../src/tool/stored-output"
import { Storage } from "../../src/storage/storage"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"

for (const kind of ["asset", "tool-output"] as const)
  test(`organization ${kind} references require source authority even when the binding is outside the selected projection`, async () => {
    await using source = await testRuntime({
      register() {
        Core.register()
        Evidence.register()
      },
    })
    await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, environmentID: null })
          const reference =
            kind === "asset"
              ? `asset://${await Asset.write(Buffer.from("unscoped Home object"), "text/plain")}`
              : await StoredToolOutput.save("tool_unscoped_home_output", "unscoped Home output")
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            rootID: messageID,
            time: { created: 1 },
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            text: reference,
          })
          await Session.flushPartWrites(session.id)
          const infoKey = ["sessions", "home", session.id, "info"]
          await Storage.write(infoKey, {
            ...(await Storage.read<Record<string, unknown>>(infoKey)),
            organization: { organizationID: "fixture-organization", projectID: "fixture-project" },
          })
          expect(
            Session.Info.parse(await Session.get(session.id)) as unknown as Record<string, unknown>,
          ).not.toHaveProperty("organization")
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          const binding = {
            sessionID: session.id,
            rootSessionID: session.id,
            scopeID: "home",
            handoffID: `unscoped-${kind}`,
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.beginSource(binding)
          const context = {
            session: Session.Info.parse(await Session.get(session.id)),
            rootSessionID: session.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          }
          await Owners.freeze(context, await Owners.selected(context))
          await Epochs.freeze(binding)
          const open = kind === "asset" ? spyOn(Asset, "open") : spyOn(StoredToolOutput, "open")
          try {
            await expect(
              Evidence.seal({
                root: context,
                sessions: (async function* () {
                  yield context
                })(),
              }),
            ).rejects.toThrow("source authority")
            expect(open).not.toHaveBeenCalled()
          } finally {
            open.mockRestore()
          }
        },
      }),
    )
  })

test("aggregate deduplication retains each source authority and rechecks revocation before export", async () => {
  let deniedSessionID: string | undefined
  let reference = ""
  let revoked = false
  await using source = await testRuntime({
    register() {
      Core.register()
      Evidence.register({
        sourceAuthority: {
          async authorize({ source, ownerID, dependency }) {
            await Epochs.assertFrozen(source.session.id, source.handoffID)
            expect(ownerID).toBe("session-core")
            expect(dependency.reference).toBe(reference)
            if (revoked || source.session.id === deniedSessionID) throw new Error("Source grant revoked")
          },
        },
      })
    },
  })
  await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        const child = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        reference = `asset://${await Asset.write(Buffer.from("same object, separate source authority"), "text/plain")}`
        const contexts: Owners.SourceContext[] = []
        for (const session of [root, child]) {
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            rootID: messageID,
            time: { created: 1 },
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            text: reference,
          })
          await Session.flushPartWrites(session.id)
          if (session.id === root.id) {
            const key = ["sessions", "home", session.id, "info"]
            await Storage.write(key, {
              ...(await Storage.read<Record<string, unknown>>(key)),
              organization: { organizationID: "fixture-organization", projectID: "fixture-project" },
            })
          }
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          const binding = {
            sessionID: session.id,
            rootSessionID: root.id,
            scopeID: "home",
            handoffID: "source-authority",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.beginSource(binding)
          const context = {
            session: Session.Info.parse(await Session.get(session.id)),
            rootSessionID: root.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          }
          await Owners.freeze(context, await Owners.selected(context))
          await Epochs.freeze(binding)
          contexts.push(context)
        }
        const seal = () =>
          Evidence.seal({
            root: contexts[0],
            sessions: (async function* () {
              yield* contexts
            })(),
          })
        deniedSessionID = child.id
        await expect(seal()).rejects.toThrow("Source grant revoked")
        deniedSessionID = undefined
        expect((await seal()).assets).toBe(1)
        revoked = true
        await expect(seal()).rejects.toThrow("Source grant revoked")
        await expect(Owners.entries(contexts[0], ["session-evidence"])[Symbol.asyncIterator]().next()).rejects.toThrow(
          "Source grant revoked",
        )
      },
    }),
  )
})

test("a frozen aggregate exports complete deduplicated Asset/output dependencies before paused Session publication", async () => {
  await using objects = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized portable object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  const register = () => {
    Core.register()
    Evidence.register()
  }
  await using source = await testRuntime({ register })
  const frozen = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        const child = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        const assetID = await Asset.write(Buffer.from("full referenced asset"), "text/plain")
        const hiddenID = await Asset.write(Buffer.from("asset referenced only by complete output"), "text/plain")
        const rawID = await Asset.write(Buffer.from("asset referenced only by raw tool result"), "text/plain")
        const output = "retained complete tool output🌏".repeat(10000) + `\n\n![hidden original](asset://${hiddenID})`
        const reference = await StoredToolOutput.save("tool_portable_dependency", output, [
          "/old-device/tool_portable_dependency",
        ])
        for (const session of [root, child]) {
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            rootID: messageID,
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
            time: { created: 1 },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            text: "outside display budget ".repeat(14000) + `\n\n![retained](asset://${assetID})`,
          })
          if (session.id === root.id) {
            const owner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
            await RolloutLedger.beginRun(owner, messageID)
            const execution = await RolloutLedger.beginTool({
              owner,
              runID: messageID,
              messageID,
              toolCallID: "raw-result",
              tool: "fixture",
              args: {},
            })
            await RolloutLedger.writeTool({
              ...execution,
              status: "completed",
              ended: Date.now(),
              rawResult: await RolloutArtifact.writeText(
                owner,
                JSON.stringify({ visual: { url: `asset://${rawID}` } }),
                "application/json",
              ),
            })
            await RolloutLedger.finishRun(owner, messageID, "completed")
          }
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: "retained-output",
            tool: "fixture",
            state: {
              status: "completed",
              input: {},
              output: "preview",
              outputTruncated: true,
              outputBytes: Buffer.byteLength(output),
              title: "Retained output",
              metadata: { outputPath: "/old-device/tool_portable_dependency" },
              time: { start: 1, end: 2 },
            },
          })
          await Session.flushPartWrites(session.id)
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        }
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          rootSessionID: root.id,
          handoffID: "portable-evidence",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const contexts = [root, child].map((session) => ({
          session,
          rootSessionID: root.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }))
        for (const context of contexts) await Epochs.beginSource({ ...binding, sessionID: context.session.id })
        for (const context of contexts) await Owners.freeze(context, await Owners.selected(context))
        for (const context of contexts.toReversed()) await Epochs.freeze({ ...binding, sessionID: context.session.id })
        await expect(
          Evidence.seal({
            root: contexts[0],
            sessions: (async function* () {
              yield contexts[0]
            })(),
          }),
        ).rejects.toThrow("child")
        const sealed = await Evidence.seal({
          root: contexts[0],
          sessions: (async function* () {
            yield* contexts
          })(),
        })
        expect(sealed).toMatchObject({ members: 2, assets: 3, outputs: 1, aliases: 1 })
        const owners = Object.assign(
          {},
          ...contexts.map((context) =>
            Owners.versions(context.session.id === root.id ? ["session-core", "session-evidence"] : ["session-core"]),
          ),
        )
        const portable = await Stream.write({
          store,
          owners,
          entries: (async function* () {
            for (const context of contexts) yield* Owners.entries(context, await Owners.selected(context))
          })(),
        })
        return {
          root: await Session.get(root.id),
          child: await Session.get(child.id),
          binding,
          portable,
          assetID,
          hiddenID,
          rawID,
          output,
          reference,
        }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const staged = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.portable, store })
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const session of [frozen.root, frozen.child])
          for (const ownerID of session.id === frozen.root.id
            ? ["session-core", "session-evidence"]
            : ["session-core"]) {
            const context = await Staging.context({
              handoffID: frozen.binding.handoffID,
              ownerID,
              session,
              rootSessionID: frozen.root.id,
              mapping: {},
              signal: new AbortController().signal,
            })
            await Owners.validate(ownerID, context)
            contexts.push({ ownerID, context })
          }
        expect(await (await Asset.read(frozen.assetID))!.text()).toBe("full referenced asset")
        expect(await (await Asset.read(frozen.hiddenID))!.text()).toBe("asset referenced only by complete output")
        expect(await (await Asset.read(frozen.rawID))!.text()).toBe("asset referenced only by raw tool result")
        await expect(Session.get(frozen.root.id)).rejects.toThrow()
        expect((await Session.list()).data).toEqual([])
        await expect(StoredToolOutput.read({ reference: frozen.reference })).rejects.toThrow()
        const bindings = [frozen.root, frozen.child].map((session) => ({ ...frozen.binding, sessionID: session.id }))
        for (const binding of bindings) await Epochs.reserve(binding, staged.rootHash)
        const evidence = contexts.find((value) => value.ownerID === "session-evidence")!.context
        expect(Evidence.prepared(evidence).digest).toHaveLength(64)
        await StoredToolOutput.save("tool_portable_dependency", "retained target collision")
        await expect(Owners.validate("session-evidence", evidence)).rejects.toThrow("collides")
        expect(() => Evidence.prepared(evidence)).toThrow("prepared target context")
        await expect(
          Epochs.activateMany({
            bindings,
            manifestHash: staged.rootHash,
            publish: () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts }),
          }),
        ).rejects.toThrow("prepared target context")
        await expect(Session.get(frozen.root.id)).rejects.toThrow()
        expect((await StoredToolOutput.read({ reference: frozen.reference })).text).toBe("retained target collision")
        await Storage.removeTree(["tool_outputs", "tool_portable_dependency"])
        await Owners.validate("session-evidence", evidence)
        await Epochs.activateMany({
          bindings,
          manifestHash: staged.rootHash,
          publish: () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts }),
        })
        expect((await Session.get(frozen.root.id)).paused).toEqual(frozen.root.paused)
        expect((await Session.get(frozen.child.id)).parentID).toBe(frozen.root.id)
        const retained = await StoredToolOutput.read({ reference: "/old-device/tool_portable_dependency", limit: 1000 })
        expect(frozen.output.startsWith(retained.text)).toBe(true)
        expect(Buffer.byteLength(retained.text)).toBeLessThanOrEqual(1000)
      },
    }),
  )
}, 20000)

test("missing source dependencies leave a frozen aggregate unsealed and cancellation keeps it paused", async () => {
  await using runtime = await testRuntime({
    register() {
      Core.register()
      Evidence.register()
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "text",
          text: "![missing canonical Asset](asset://0000000000000000.png)",
        })
        await Session.flushPartWrites(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          rootSessionID: session.id,
          scopeID: "home",
          handoffID: "missing-evidence",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        await Owners.freeze(context, await Owners.selected(context))
        await Epochs.freeze(binding)
        await expect(
          Evidence.seal({
            root: context,
            sessions: (async function* () {
              yield context
            })(),
          }),
        ).rejects.toMatchObject({ data: { requirements: [{ code: "asset_missing", owner: "session-evidence" }] } })
        expect(await Epochs.isFrozen(session.id)).toBe(true)
        await expect(
          (async () => {
            for await (const _entry of Owners.entries(context, ["session-evidence"])) {
            }
          })(),
        ).rejects.toThrow("sealed")
        await Epochs.cancel(binding)
        expect((await Session.get(session.id)).paused).toBeDefined()
        expect((await Epochs.inspect(binding)).phase).toBe("cancelled")
      },
    }),
  )
})

test("a restarted target revalidates persistent staging before rebuilding its Runtime-bound prepared proof", async () => {
  await using objects = await tmpdir()
  await using targetHome = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized portable object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  const register = () => {
    Core.register()
    Evidence.register()
  }
  await using source = await testRuntime({ register })
  const frozen = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const id = await Asset.write(Buffer.from("restart-safe Asset"), "text/plain")
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "text",
          text: `![restart](asset://${id})`,
        })
        await Session.flushPartWrites(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          rootSessionID: session.id,
          scopeID: "home",
          handoffID: "restart-evidence",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        const owners = await Owners.selected(context)
        await Owners.freeze(context, owners)
        await Epochs.freeze(binding)
        await Evidence.seal({
          root: context,
          sessions: (async function* () {
            yield context
          })(),
        })
        const portable = await Stream.write({
          store,
          owners: Owners.versions(owners),
          entries: Owners.entries(context, owners),
        })
        return { binding, session: await Session.get(session.id), portable, id }
      },
    }),
  )
  let originalDigest!: string
  let manifestHash!: string
  {
    await using target = await testRuntime({ home: targetHome.path, register })
    await target.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const staged = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.portable, store })
          manifestHash = staged.rootHash
          const context = await Staging.context({
            handoffID: frozen.binding.handoffID,
            ownerID: "session-evidence",
            session: frozen.session,
            rootSessionID: frozen.session.id,
            mapping: {},
            signal: new AbortController().signal,
          })
          await Owners.validate("session-evidence", context)
          originalDigest = Evidence.prepared(context).digest
          await Epochs.reserve(frozen.binding, manifestHash)
        },
      }),
    )
  }
  await using restarted = await testRuntime({ home: targetHome.path, register })
  await restarted.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const ownerID of ["session-core", "session-evidence"])
          contexts.push({
            ownerID,
            context: await Staging.context({
              handoffID: frozen.binding.handoffID,
              ownerID,
              session: frozen.session,
              rootSessionID: frozen.session.id,
              mapping: {},
              signal: new AbortController().signal,
            }),
          })
        const publish = () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts })
        await expect(Epochs.activate(frozen.binding, manifestHash, publish)).rejects.toThrow("prepared target context")
        await expect(Session.get(frozen.session.id)).rejects.toThrow()
        expect((await Epochs.inspect(frozen.binding)).phase).toBe("prepared")
        for (const { ownerID, context } of contexts) await Owners.validate(ownerID, context)
        expect(Evidence.prepared(contexts[1].context).digest).toBe(originalDigest)
        await Epochs.activate(frozen.binding, manifestHash, publish)
        expect((await Session.get(frozen.session.id)).paused).toEqual(frozen.session.paused)
        expect(await (await Asset.read(frozen.id))!.text()).toBe("restart-safe Asset")
      },
    }),
  )
}, 15000)
