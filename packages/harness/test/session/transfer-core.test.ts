import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionInbox } from "../../src/session/inbox"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionHistory } from "../../src/session/history"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { RolloutLedger } from "../../src/session/rollout/ledger"

test("returning Core publication replaces warm message order after removals, additions and reordered history", async () => {
  await using directory = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  const home = path.join(directory.path, "original")
  await using original = await testRuntime({ home, register: Core.register })
  await using destination = await testRuntime({ register: Core.register })
  const ids = [0, 1, 2, 3].map(() => Identifier.ascending("message"))
  const session = await original.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        for (const [index, messageID] of ids.slice(0, 3).entries()) {
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: index + 1 },
            isRoot: true,
            rootID: messageID,
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            text: "Original message " + index,
          })
        }
        await Session.flushPartWrites(session.id)
        return Session.get(session.id)
      },
    }),
  )
  const signal = new AbortController().signal
  const transfer = async (source: typeof original, target: typeof original, binding: Epochs.Binding) => {
    const captured = await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: () =>
          Source.prepare({
            binding,
            store,
            signal,
            async verify() {
              signal.throwIfAborted()
              await Core.storedInfo({ scopeID: binding.scopeID, sessionID: binding.sessionID })
            },
          }),
      }),
    )
    await target.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const received = await Staging.receive({ handoffID: binding.handoffID, root: captured.root, store, signal })
          const context = await Staging.context({
            handoffID: binding.handoffID,
            ownerID: "session-core",
            session: await source.run(() => Session.get(session.id)),
            rootSessionID: session.id,
            mapping: {},
            signal,
          })
          await Owners.validate("session-core", context)
          await Epochs.reserve(binding, received.rootHash, await Epochs.destinationPrior(binding))
          await source.run(() =>
            Source.surrender({
              binding,
              manifestHash: captured.manifestHash,
              preparedHash: received.rootHash,
              signal,
              async verify() {
                signal.throwIfAborted()
                expect((await Source.status(binding))?.manifestHash).toBe(captured.manifestHash)
              },
            }),
          )
          await Epochs.activate(binding, received.rootHash, () =>
            Staging.publish({ handoffID: binding.handoffID, contexts: [{ ownerID: "session-core", context }] }),
          )
        },
      }),
    )
  }
  await original.run(async () => {
    expect((await Session.messages({ sessionID: session.id })).map(({ info }) => info.id)).toEqual(ids.slice(0, 3))
    expect((await SessionHistory.timelinePage({ sessionID: session.id, limit: 100 })).items).toHaveLength(3)
  })
  await transfer(original, destination, {
    sessionID: session.id,
    scopeID: "home",
    handoffID: "order-outbound",
    sourceID: "A",
    targetID: "B",
    fromEpoch: 1,
    toEpoch: 2,
  })
  await destination.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Session.removeMessage({ sessionID: session.id, messageID: ids[1]! })
        await Session.updateMessage({
          id: ids[2]!,
          sessionID: session.id,
          role: "user",
          time: { created: 0 },
          isRoot: true,
          rootID: ids[2]!,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updateMessage({
          id: ids[3]!,
          sessionID: session.id,
          role: "user",
          time: { created: 2 },
          isRoot: true,
          rootID: ids[3]!,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: ids[3]!,
          type: "text",
          text: "Added on destination",
        })
        await Session.flushPartWrites(session.id)
        expect((await Session.messages({ sessionID: session.id })).map(({ info }) => info.id)).toEqual([
          ids[2],
          ids[0],
          ids[3],
        ])
      },
    }),
  )
  const expected = await destination.run(() => Session.messages({ sessionID: session.id }))
  const expectedDetails = await destination.run(() =>
    SessionHistory.messageDetails({ sessionID: session.id, messageID: ids[3]! }),
  )
  await transfer(destination, original, {
    sessionID: session.id,
    scopeID: "home",
    handoffID: "order-return",
    sourceID: "B",
    targetID: "A",
    fromEpoch: 2,
    toEpoch: 3,
  })
  const inspect = async () => {
    expect(await Session.messages({ sessionID: session.id })).toEqual(expected)
    expect((await Session.messagePage({ sessionID: session.id, limit: 100 })).items).toEqual(expected)
    const page = await SessionHistory.timelinePage({ sessionID: session.id, limit: 100 })
    expect(page.total).toBe(expected.length)
    expect(page.items.map(({ info }) => info.id)).toEqual(expected.map(({ info }) => info.id))
    expect(await SessionHistory.messageDetails({ sessionID: session.id, messageID: ids[3]! })).toEqual(expectedDetails)
    expect((await Session.get(session.id)).paused).toBeDefined()
  }
  await original.run(inspect)
  await original.close()
  await using cold = await testRuntime({ home, register: Core.register })
  await cold.run(inspect)
})

test("the native core owner preserves message, Inbox, binary and unknown retained fields without replay", async () => {
  await using directory = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime({ register: Core.register })
  const evidence = await source.run(() =>
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
          time: { created: 1 },
          isRoot: true,
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Storage.update<Record<string, unknown>>(
          ["sessions", "home", session.id, "messages", messageID, "info"],
          (draft) => {
            draft.retainedFutureMessage = { unchanged: true }
            draft.summary = {
              diffs: [{ file: "history.txt", additions: 1, deletions: 0 }],
              diffRevision: "source-runtime-local-diff",
              diffTotals: { files: 1, additions: 1, deletions: 0 },
              diffObservedAt: 42,
              diffHasChanges: true,
              retainedFutureSummary: { unchanged: true },
            }
          },
        )
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "text",
          text: "Keep the completed work and /old-host/path as evidence.",
        })
        await Session.flushPartWrites(session.id)
        const toolPartID = Identifier.ascending("part")
        const attachmentBytes = new Uint8Array([0, 255, 128, 1])
        const attachment = await RolloutArtifact.write(
          { kind: "session", scopeID: "home", sessionID: session.id },
          (async function* () {
            yield attachmentBytes
          })(),
          "application/octet-stream",
        )
        await Session.updatePart({
          id: toolPartID,
          sessionID: session.id,
          messageID,
          type: "tool",
          tool: "fixture",
          callID: "portable-attachments",
          state: {
            status: "completed",
            input: {},
            output: "Created evidence",
            title: "Evidence",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments: [
              {
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID,
                type: "attachment",
                url: "https://unresolved.invalid/evidence.bin",
                filename: "portable.bin",
                mime: "application/octet-stream",
                artifact: attachment,
              },
            ],
          },
        })
        const toolPart = await Storage.read([
          "sessions",
          "home",
          session.id,
          "messages",
          messageID,
          "parts",
          toolPartID,
        ])
        await SessionHistory.attachmentPage({ sessionID: session.id, messageID, partID: toolPartID })
        const fieldMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: fieldMessageID,
          sessionID: session.id,
          role: "assistant",
          rootID: messageID,
          parentID: messageID,
          agent: "general",
          mode: "general",
          providerID: "fixture",
          modelID: "fixture",
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2, completed: 3 },
        })
        const fieldOwner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
        const fieldInput = { original: "Exact original input 你好" }
        const fieldOutput = "Exact original output 你好"
        await RolloutLedger.beginRun(fieldOwner, messageID)
        const tool = await RolloutLedger.beginTool({
          owner: fieldOwner,
          runID: messageID,
          messageID: fieldMessageID,
          toolCallID: "portable-fields",
          tool: "fixture",
          args: fieldInput,
        })
        await RolloutLedger.writeTool({ ...tool, status: "completed", ended: Date.now() })
        await RolloutLedger.finishRun(fieldOwner, messageID, "completed")
        const fieldPartID = Identifier.ascending("part")
        await Session.updatePart({
          id: fieldPartID,
          sessionID: session.id,
          messageID: fieldMessageID,
          type: "tool",
          callID: "portable-fields",
          tool: "fixture",
          state: {
            status: "completed",
            input: { normalized: "This is a display value, not the original args" },
            output: fieldOutput,
            title: "Original fields",
            metadata: {},
            time: { start: 2, end: 3 },
          },
        })
        const delivery = await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: "portable-context",
          mode: "context",
          message: { role: "user", parts: [{ type: "text", text: "Do not run this during import." }] },
        })
        const key = ["sessions", "home", session.id, "info"]
        await Storage.update<Record<string, unknown>>(key, (draft) => {
          draft.retainedFutureField = { exact: [1, "unchanged"] }
          draft.interaction = { mode: "interactive", source: "fixture", future: { proof: "keep nested owner data" } }
        })
        const artifact = ["sessions", "home", session.id, "rollout", "blobs", "retained"]
        await Storage.writeBinary(artifact, new Uint8Array([0, 255, 21]))
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "native-core",
          sourceID: "A",
          targetID: "B",
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
        expect(owners).toEqual(["session-core"])
        expect((await Owners.inspect(context, owners)).requirements).toEqual([])
        await Owners.freeze(context, owners)
        await Epochs.freeze(binding)
        const root = await Stream.write({
          store,
          owners: Owners.versions(owners),
          entries: Owners.entries(context, owners),
        })
        return {
          session: await Session.get(session.id),
          binding,
          root,
          delivery,
          artifact,
          messageID,
          toolPartID,
          toolPart,
          attachmentBytes,
          fieldMessageID,
          fieldPartID,
          fieldInput,
          fieldOutput,
        }
      },
    }),
  )
  await using target = await testRuntime({ register: Core.register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const partKey = [
          "sessions",
          "home",
          evidence.session.id,
          "messages",
          evidence.messageID,
          "parts",
          evidence.toolPartID,
        ]
        const staged = await Staging.receive({ handoffID: evidence.binding.handoffID, root: evidence.root, store })
        const context = await Staging.context({
          handoffID: evidence.binding.handoffID,
          ownerID: "session-core",
          session: evidence.session,
          rootSessionID: evidence.session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        for await (const record of context.staged.records()) {
          expect(record.key[3]).not.toBe("attachment_index")
          expect(record.key[3]).not.toBe("part_field_sources")
          expect(record.key[3] === "rollout" && ["tool_parts", "tool_part_schema"].includes(record.key[4]!)).toBe(false)
        }
        for (const branch of [
          ["attachment_index", evidence.messageID, evidence.toolPartID, "header"],
          ["part_field_sources", evidence.messageID, evidence.toolPartID, "header"],
          ["rollout", "tool_parts", "untrusted-run", "untrusted-digest"],
          ["rollout", "tool_part_schema"],
        ]) {
          await expect(
            Owners.validate("session-core", {
              ...context,
              staged: {
                ...context.staged,
                records: async function* () {
                  yield* context.staged.records()
                  yield {
                    key: ["sessions", "home", evidence.session.id, ...branch],
                    value: { version: 1, revision: "1", kind: "tool", count: 1 },
                  }
                },
              },
            }),
          ).rejects.toThrow("another owner's records")
        }
        await Owners.validate("session-core", context)
        await Epochs.reserve(evidence.binding, staged.rootHash)
        await Epochs.activate(evidence.binding, staged.rootHash, async () => {
          for (let index = 0; index < 3; index++) await Storage.write(partKey, evidence.toolPart)
          await Staging.publish({
            handoffID: evidence.binding.handoffID,
            contexts: [{ ownerID: "session-core", context }],
          })
        })
        await (async () => {
          const versioned = StoreTransaction.prototype.versioned
          using noPartBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            key: string[],
          ) {
            if (
              JSON.stringify(key) === JSON.stringify(partKey) ||
              (key[4] === evidence.fieldMessageID && key[6] === evidence.fieldPartID)
            )
              throw new Error("Activated native fields must use their rebuilt target projection")
            return (versioned<T>).call(this, key)
          })
          const fields = await SessionHistory.partFieldDescriptor({
            sessionID: evidence.session.id,
            messageID: evidence.messageID,
            partID: evidence.toolPartID,
          })
          const input = await SessionHistory.partField({
            sessionID: evidence.session.id,
            messageID: evidence.messageID,
            partID: evidence.toolPartID,
            field: "input",
            version: fields.version,
            offset: 0,
            length: 128,
          })
          expect(new TextDecoder().decode(input.data)).toBe("{}")
          const original = {
            sessionID: evidence.session.id,
            messageID: evidence.fieldMessageID,
            partID: evidence.fieldPartID,
          }
          const references = await SessionHistory.partFieldDescriptor(original)
          for (const [field, expected] of [
            ["input", JSON.stringify(evidence.fieldInput)],
            ["output", evidence.fieldOutput],
          ] as const) {
            const range = await SessionHistory.partField({
              ...original,
              field,
              version: references.version,
              offset: 0,
              length: 128,
            })
            expect(new TextDecoder().decode(range.data)).toBe(expected)
          }
        })()
        expect((await Session.get(evidence.session.id)).paused).toEqual(evidence.session.paused)
        expect(await Storage.read(["sessions", "home", evidence.session.id, "info"])).toMatchObject({
          retainedFutureField: { exact: [1, "unchanged"] },
          interaction: { future: { proof: "keep nested owner data" } },
        })
        expect(
          (await Session.messages({ sessionID: evidence.session.id, raw: true })).find(
            (message) => message.info.id === evidence.messageID,
          )?.parts[0],
        ).toMatchObject({ type: "text", text: "Keep the completed work and /old-host/path as evidence." })
        expect(
          (await SessionInbox.list(evidence.session.id)).find((item) => item.id === evidence.delivery.itemID)?.mode,
        ).toBe("context")
        expect(await Storage.readBinary(evidence.artifact)).toEqual(new Uint8Array([0, 255, 21]))
        const message = await Storage.read<Record<string, unknown>>([
          "sessions",
          "home",
          evidence.session.id,
          "messages",
          evidence.messageID,
          "info",
        ])
        expect(message.retainedFutureMessage).toEqual({ unchanged: true })
        expect(message.summary).toEqual({
          diffs: [],
          diffState: { status: "error", code: "incomplete" },
          retainedFutureSummary: { unchanged: true },
        })
        expect((await Session.list()).data.some((session) => session.id === evidence.session.id)).toBe(true)
        const files = await SessionHistory.attachmentPage({
          sessionID: evidence.session.id,
          messageID: evidence.messageID,
          partID: evidence.toolPartID,
        })
        expect(files.items).toEqual([
          {
            ordinal: 0,
            filename: "portable.bin",
            mediaType: "application/octet-stream",
            bytes: evidence.attachmentBytes.length,
          },
        ])
        const content = await SessionHistory.attachmentContent({
          sessionID: evidence.session.id,
          messageID: evidence.messageID,
          partID: evidence.toolPartID,
          version: files.version,
          ordinal: 0,
          offset: 0,
          length: 4,
        })
        expect(content.state).toBe("ready")
        if (content.state !== "ready") throw new Error("Expected target-owned attachment evidence")
        expect(content.data).toEqual(evidence.attachmentBytes)
      },
    }),
  )
})

test("core preparation cannot accept an unsettled tool or omit the required historical Snapshot owner", async () => {
  await using runtime = await testRuntime({ register: Core.register })
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
          time: { created: 1 },
          isRoot: true,
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "snapshot",
          snapshot: "a".repeat(40),
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: "unsettled",
          tool: "fixture",
          state: { status: "generating", input: {}, raw: "{", charsReceived: 1 },
        })
        await Session.flushPartWrites(session.id)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: "required-snapshots",
          signal: new AbortController().signal,
        }
        const inspected = await Owners.inspect(context, ["session-core"])
        expect(inspected.requirements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "owner_missing", owner: "session-snapshots" }),
            expect.objectContaining({ code: "tool_unsettled", owner: "session-core" }),
          ]),
        )
      },
    }),
  )
})
