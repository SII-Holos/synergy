import { afterAll, expect, test } from "bun:test"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { historicalReferenceContext, migrateReferenceContexts } from "../../src/session/reference-context"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const original = { id: "wsp_original", generation: 3, root: "/original" }

test("historical references require recorded ownership, not a currently selected directory", () => {
  expect(historicalReferenceContext({ role: "assistant", path: { cwd: "/original/docs" } }, [original])).toEqual({
    state: "bound",
    workspace: original,
    directory: "docs",
  })
  expect(historicalReferenceContext({ role: "assistant", path: { cwd: "/original" } }, [])).toEqual({
    state: "unresolved",
  })
  expect(
    historicalReferenceContext({ role: "assistant", path: { cwd: "/original" } }, [
      original,
      { ...original, generation: 4 },
    ]),
  ).toEqual({ state: "unresolved" })
  expect(historicalReferenceContext({ role: "assistant", path: { cwd: null, root: null } }, [])).toEqual({
    state: "none",
  })
})

test("new messages retain captured ownership and migration is owner-local and repeatable", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const id = Identifier.ascending("message")
        const info = await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        expect(ResourceReference.Context.safeParse(info.referenceContext).success).toBe(true)
        const key = StoragePath.messageInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          id,
        )
        const foreign = await Session.create({})
        const foreignKey = StoragePath.messageInfo(
          Identifier.asScopeID(foreign.scope.id),
          Identifier.asSessionID(foreign.id),
          id,
        )
        const legacy = { ...info, referenceContext: undefined }
        await Storage.write(key, legacy)
        await Storage.write(foreignKey, legacy)
        const owner = { scopeID: session.scope.id, sessionID: session.id }
        await migrateReferenceContexts(owner, () => {})
        const upgraded = await Storage.read<MessageV2.Info>(key)
        expect(upgraded.referenceContext).toEqual({ state: "unresolved" })
        expect((await Storage.read<MessageV2.Info>(foreignKey)).referenceContext).toBeUndefined()
        await migrateReferenceContexts(owner, () => {})
        expect(await Storage.read<MessageV2.Info>(key)).toEqual(upgraded)
        const changed = await Session.updateMessage({ ...info, time: { created: 2 } })
        expect(changed.referenceContext).toEqual(info.referenceContext)
      },
    })
  }))

test("migration uses the message’s recorded snapshot and transfer remaps origin without changing content", () =>
  runtime.run(async () => {
    const { WorkspaceTransfer } = await import("../../src/session/workspace-transfer")
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const info: MessageV2.Assistant = {
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: Identifier.ascending("message"),
          modelID: "test",
          providerID: "test",
          mode: "build",
          agent: "test",
          path: { cwd: "/original/docs", root: "/original" },
          time: { created: 1 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        const key = StoragePath.messageInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          messageID,
        )
        await Storage.write(key, info)
        await Storage.write([...key.slice(0, 5), "parts", Identifier.ascending("part")], {
          type: "step-start",
          workspace: original,
        })
        await SessionHistoryDisplay.messageWritten(session.scope.id, info)
        expect(
          (await SessionHistoryDisplay.header(session.scope.id, session.id, messageID))?.info.referenceContext,
        ).toBeUndefined()
        await migrateReferenceContexts({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        const migrated = await Storage.read<MessageV2.Info>(key)
        expect(migrated.referenceContext).toEqual({ state: "bound", workspace: original, directory: "docs" })
        await SessionHistoryDisplay.prepare(session.scope.id, session.id, async () => [migrated])
        expect(
          (await SessionHistoryDisplay.header(session.scope.id, session.id, messageID))?.info.referenceContext,
        ).toEqual(migrated.referenceContext)
        const message: MessageV2.WithParts = {
          info: migrated,
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID,
              type: "attachment",
              url: "asset://0123456789abcdef.png",
              mime: "image/png",
              source: {
                type: "file",
                path: "/original/chart.png",
                text: { value: "", start: 0, end: 0 },
                workspace: original,
              },
            },
          ],
        }
        const transferred = WorkspaceTransfer.message(message, new Map([[original.id, "wsp_imported"]]))
        expect(transferred.info.referenceContext).toMatchObject({
          workspace: { id: "wsp_imported", generation: 3, root: "/original" },
        })
        expect(transferred.parts[0]).toMatchObject({
          url: "asset://0123456789abcdef.png",
          source: { workspace: { id: "wsp_imported" } },
        })
        expect(message.info.referenceContext).toMatchObject({ workspace: { id: original.id } })
      },
    })
  }))

test("migration refreshes materialized history across batches and records already upgraded at ingress", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const scopeID = Identifier.asScopeID(session.scope.id)
        const sessionID = Identifier.asSessionID(session.id)
        const infos = Array.from(
          { length: 205 },
          (_, index): MessageV2.User => ({
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: index + 1 },
          }),
        )
        await Storage.transaction((tx) =>
          tx.writeMany(
            infos.map((value) => ({
              key: StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(value.id)),
              value,
            })),
          ),
        )
        await SessionHistoryDisplay.invalidate(scopeID, sessionID)
        await SessionHistoryDisplay.prepare(scopeID, sessionID, async () => infos)
        await migrateReferenceContexts({ scopeID, sessionID }, () => {})
        const upgraded = await Storage.readMany<MessageV2.Info>(
          infos.map((value) => StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(value.id))),
        )
        expect(upgraded.every((info) => info?.referenceContext?.state === "unresolved")).toBe(true)
        const noRebuild = async (): Promise<MessageV2.Info[]> => {
          throw new Error("Reference migration must preserve the ready display projection")
        }
        await SessionHistoryDisplay.prepare(scopeID, sessionID, noRebuild)
        expect(
          (await SessionHistoryDisplay.header(scopeID, sessionID, infos.at(-1)!.id))?.info.referenceContext,
        ).toEqual({ state: "unresolved" })
        await SessionHistoryDisplay.messageWritten(scopeID, infos[0]!)
        await migrateReferenceContexts({ scopeID, sessionID }, () => {})
        await SessionHistoryDisplay.prepare(scopeID, sessionID, noRebuild)
        expect((await SessionHistoryDisplay.header(scopeID, sessionID, infos[0]!.id))?.info.referenceContext).toEqual({
          state: "unresolved",
        })
      },
    })
  }))
