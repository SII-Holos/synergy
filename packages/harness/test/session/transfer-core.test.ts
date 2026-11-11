import { expect, test } from "bun:test"
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
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"

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
        return { session: await Session.get(session.id), binding, root, delivery, artifact, messageID }
      },
    }),
  )
  await using target = await testRuntime({ register: Core.register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const staged = await Staging.receive({ handoffID: evidence.binding.handoffID, root: evidence.root, store })
        const context = await Staging.context({
          handoffID: evidence.binding.handoffID,
          ownerID: "session-core",
          session: evidence.session,
          rootSessionID: evidence.session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        await Owners.validate("session-core", context)
        await Epochs.reserve(evidence.binding, staged.rootHash)
        await Epochs.activate(evidence.binding, staged.rootHash, () =>
          Staging.publish({ handoffID: evidence.binding.handoffID, contexts: [{ ownerID: "session-core", context }] }),
        )
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
