import { expect, test } from "bun:test"
import { z } from "zod"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  SessionTransferCore as Core,
  SessionTransferEnvironments as Environments,
  SessionTransferSource as Source,
  SessionTransferStaging as Staging,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
  SessionTransferStream as Stream,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { testRuntime } from "./support/runtime"

const register = () => {
  Core.register()
  Environments.register()
}

test("source preparation saves an exited native operation and retains its original history on another Home", async () => {
  await using targetDirectory = await tmpdir()
  const values = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      const bytes = values.get(hash)
      if (!bytes || bytes.length > maximum) throw new Error("Missing native history fixture object")
      return bytes.slice()
    },
  }
  const signal = new AbortController().signal
  const output = "owned-native-history\n".repeat(16_384)
  await using source = await testRuntime({ register })
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "native-history-source",
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
        const tool = await RolloutLedger.beginTool({
          owner,
          runID: rootID,
          messageID,
          toolCallID: "native-history-tool",
          tool: "bash",
          args: {},
        })
        const origin: EnvironmentOrigin.Session = {
          kind: "session",
          scopeID: "home",
          sessionID: session.id,
          rootID,
          runID: rootID,
          messageID,
          callID: "native-history-tool",
          tool: "bash",
        }
        const command = {
          command: process.execPath,
          args: ["-e", "process.stdout.write('owned-native-history\\n'.repeat(16384))"],
          cwd: source.host.root,
          env: {},
          useRoots: [],
        }
        let execution = await EnvironmentExecution.start({
          id: "owned-native-history-operation",
          scopeID: "home",
          environmentID: environment.id,
          origin,
          command,
          signal,
        })
        for (let attempt = 0; execution.state !== "exited" && attempt < 400; attempt++) {
          await Bun.sleep(10)
          execution = await EnvironmentExecution.reconcile(execution.id, "home")
        }
        expect(execution.state).toBe("exited")
        const originalKey = ["environment_execution", "home", execution.id]
        const stored = z.record(z.string(), z.unknown()).parse(await Storage.read(originalKey))
        const pendingRecord = {
          ...stored,
          execution: {
            ...z.record(z.string(), z.unknown()).parse(stored.execution),
            retainedOwnerFields: { nested: { original: "preserved exactly" } },
          },
        }
        await Storage.write(originalKey, pendingRecord)
        await RolloutLedger.writeTool({ ...tool, status: "completed", ended: Date.now() })
        const secondary = {
          ...tool,
          id: crypto.randomUUID(),
          toolCallID: "native-history-secondary",
          status: "completed" as const,
          ended: Date.now(),
          input: await RolloutArtifact.writeText(owner, JSON.stringify({ independent: true }), "application/json"),
        }
        await RolloutLedger.writeTool(secondary)
        await RolloutLedger.finishRun(owner, rootID, "completed")
        const binding = {
          scopeID: "home",
          sessionID: session.id,
          handoffID: "completed-native-environment-history",
          sourceID: "history-source",
          targetID: "history-target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        let drainingProof = false
        const prepared = await Source.prepare({
          binding,
          store,
          signal,
          async verify() {},
          async beforeFreeze() {
            await Environments.assertPreparedSource({ binding, signal })
            drainingProof = true
          },
        })
        expect(drainingProof).toBe(true)
        await Environments.assertPreparedSource({ binding, signal })
        const sealKey = ["environment_transfer", "source", binding.scopeID, binding.sessionID, binding.handoffID]
        const seal = await Storage.read<{ selected: { generation: number } }>(sealKey)
        await Storage.remove(sealKey)
        await expect(Environments.assertPreparedSource({ binding, signal })).rejects.toThrow("evidence is absent")
        await Storage.write(sealKey, seal)
        await Storage.write(sealKey, {
          ...seal,
          selected: { ...seal.selected, generation: seal.selected.generation + 1 },
        })
        await expect(Environments.assertPreparedSource({ binding, signal })).rejects.toThrow("disagrees")
        await Storage.write(sealKey, seal)
        const completed = await EnvironmentExecution.get(execution.id, "home")
        expect(completed.state).toBe("completed")
        expect(completed.outputCursor).toBeGreaterThan(1)
        const original = await Storage.read(originalKey)
        expect(original).toHaveProperty("execution.retainedOwnerFields.nested.original", "preserved exactly")
        expect(prepared.root.owners["session-environments"]).toBe(3)
        return {
          session: await Session.get(session.id),
          environment,
          completed,
          binding,
          prepared,
          origin,
          command,
          secondaryID: secondary.id,
          original,
        }
      },
    }),
  )
  await using target = await testRuntime({ register, home: targetDirectory.path })
  const targetEnvironmentID = await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const environment = await Environment.bind({
          scopeID: "home",
          ownerID: "native-history-target",
          provider: "native",
          spec: {},
        })
        await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const ownerID of ["session-core", "session-environments"]) {
          const context = await Staging.context({
            handoffID: captured.binding.handoffID,
            rootSessionID: captured.session.id,
            session: captured.session,
            ownerID,
            signal,
            mapping: { environmentID: environment.id },
          })
          await Owners.validate(ownerID, context)
          contexts.push({ ownerID, context })
        }
        await Epochs.reserve(captured.binding, captured.prepared.manifestHash)
        const rejectedPublication = new Error("Completed history publication rolled back")
        await expect(
          Epochs.activate(captured.binding, captured.prepared.manifestHash, async () => {
            await Staging.publish({ handoffID: captured.binding.handoffID, contexts })
            throw rejectedPublication
          }),
        ).rejects.toBe(rejectedPublication)
        await expect(EnvironmentExecution.get(captured.completed.id, "home")).rejects.toThrow()
        await expect(Storage.readBinary(["environment_output", "home", captured.completed.id, "1"])).rejects.toThrow()
        expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
        await expect(Session.get(captured.session.id)).rejects.toThrow()
        await Epochs.activate(captured.binding, captured.prepared.manifestHash, () =>
          Staging.publish({ handoffID: captured.binding.handoffID, contexts }),
        )
        expect(await EnvironmentExecution.get(captured.completed.id, "home")).toEqual(captured.completed)
        expect(await Storage.read(["environment_execution", "home", captured.completed.id])).toEqual(captured.original)
        let cursor = 0
        let restored = ""
        for (;;) {
          const chunks = await EnvironmentExecution.output(captured.completed.id, "home", cursor, 2)
          if (!chunks.length) break
          for (const chunk of chunks) {
            expect(chunk.cursor).toBe(++cursor)
            restored += Buffer.from(chunk.data, "base64").toString()
          }
        }
        expect(cursor).toBe(captured.completed.outputCursor)
        expect(restored).toBe(output)
        expect((await Session.get(captured.session.id)).environmentID).toBe(environment.id)
        expect((await Session.get(captured.session.id)).paused).toBeDefined()
        expect((await Environment.get(environment.id, "home")).state).toBe("idle")
        await expect(Environment.get(captured.environment.id, "home")).rejects.toThrow()
        await expect(
          EnvironmentExecution.start({
            id: captured.completed.id,
            scopeID: "home",
            environmentID: environment.id,
            origin: captured.origin,
            command: captured.command,
            signal,
          }),
        ).rejects.toThrow("different input")
        expect((await Environment.get(environment.id, "home")).state).toBe("idle")
        return environment.id
      },
    }),
  )
  await target.close()
  await using cold = await testRuntime({ register, home: targetDirectory.path })
  await cold.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        expect(await Storage.read(["environment_execution", "home", captured.completed.id])).toEqual(captured.original)
        expect((await Session.get(captured.session.id)).environmentID).toBe(targetEnvironmentID)
        expect((await Environment.get(targetEnvironmentID, "home")).state).toBe("idle")
        let cursor = 0
        let restored = ""
        while (cursor < captured.completed.outputCursor) {
          const chunks = await EnvironmentExecution.output(captured.completed.id, "home", cursor)
          expect(chunks.length).toBeGreaterThan(0)
          for (const chunk of chunks) {
            cursor = chunk.cursor
            restored += Buffer.from(chunk.data, "base64").toString()
          }
        }
        expect(restored).toBe(output)
      },
    }),
  )
  for (const mode of [
    "missing-output",
    "missing-operation",
    "wrong-cursor",
    "invalid-base64",
    "noncanonical-base64",
    "foreign-session",
    "ambiguous-tool",
  ] as const) {
    await using reader = await Stream.open({ root: captured.prepared.root, store, directory: source.host.root, signal })
    const altered = await Stream.write({
      store,
      signal,
      owners: captured.prepared.root.owners,
      entries: (async function* () {
        for await (const item of reader.entries()) {
          const key = z.array(z.string()).parse(item.metadata.key)
          const native = item.metadata.transferOwner === "session-environments"
          if (
            (mode === "missing-output" && native && key[0] === "environment_output" && key[3] === "1") ||
            (mode === "missing-operation" && native && key[0] === "environment_execution")
          ) {
            for await (const _ of item.content) {
              signal.throwIfAborted()
            }
            continue
          }
          const changeCursor = mode === "wrong-cursor" && native && key[0] === "environment_output" && key[3] === "1"
          const changeBase64 =
            (mode === "invalid-base64" || mode === "noncanonical-base64") &&
            native &&
            key[0] === "environment_output" &&
            key[3] === "1"
          const changeOrigin = mode === "foreign-session" && native && key[0] === "environment_execution"
          const changeTool = mode === "ambiguous-tool" && key.at(-1) === captured.secondaryID
          if (!changeCursor && !changeBase64 && !changeOrigin && !changeTool) {
            yield item
            continue
          }
          const chunks: Uint8Array[] = []
          for await (const chunk of item.content) chunks.push(chunk)
          const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString()))
          if (changeCursor) raw.cursor = 2
          if (changeBase64) raw.data = mode === "invalid-base64" ? "!!!!" : "YR=="
          if (changeTool) raw.toolCallID = captured.origin.callID
          if (changeOrigin) {
            const execution = z.record(z.string(), z.unknown()).parse(raw.execution)
            raw.execution = {
              ...execution,
              origin: {
                ...z.record(z.string(), z.unknown()).parse(execution.origin),
                sessionID: "another-native-session",
              },
            }
          }
          yield {
            ...item,
            content: (async function* () {
              yield Buffer.from(JSON.stringify(raw))
            })(),
          }
        }
      })(),
    })
    await using invalid = await testRuntime({ register })
    await invalid.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const environment = await Environment.bind({
            scopeID: "home",
            ownerID: "invalid-native-target",
            provider: "native",
            spec: {},
          })
          await Staging.receive({ handoffID: captured.binding.handoffID, root: altered, store, signal })
          const context = await Staging.context({
            handoffID: captured.binding.handoffID,
            rootSessionID: captured.session.id,
            session: captured.session,
            ownerID: "session-environments",
            signal,
            mapping: { environmentID: environment.id },
          })
          const validation = Owners.validate("session-environments", context)
          if (mode === "invalid-base64" || mode === "noncanonical-base64")
            await expect(validation).rejects.toThrow("canonical base64")
          else await expect(validation).rejects.toThrow()
          await expect(Session.get(captured.session.id)).rejects.toThrow()
          await expect(EnvironmentExecution.get(captured.completed.id, "home")).rejects.toThrow()
          expect(await Environment.binding("home", captured.session.id)).toBeUndefined()
          expect((await Environment.get(environment.id, "home")).state).toBe("idle")
        },
      }),
    )
  }
}, 15_000)
