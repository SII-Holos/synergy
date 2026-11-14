import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionAttachmentIndex } from "../../src/session/attachment-index"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"

async function legacyParts(count: number) {
  const session = await Session.create({ workspace: null, environmentID: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    rootID: messageID,
    isRoot: true,
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: 1 },
  })
  const parts = Array.from(
    { length: count },
    (_, index): MessageV2.Part & { futureProducerData: { retained: number } } => {
      const identity = {
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        futureProducerData: { retained: index },
      }
      if (index !== count - 1)
        return index % 2
          ? { ...identity, type: "reasoning", text: "Retained 🌏 reasoning", time: { start: 1, end: 2 } }
          : { ...identity, type: "text", text: "Retained 🌏 text" }
      return {
        ...identity,
        type: "tool",
        tool: "fixture",
        callID: "retained-files",
        state: {
          status: "completed",
          input: {},
          output: "Retained files",
          title: "Files",
          metadata: {},
          time: { start: 1, end: 2 },
          attachments: ["one.txt", "two.txt"].map((filename): MessageV2.AttachmentPart => ({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "attachment",
            filename,
            mime: "text/plain",
            url: "asset://" + filename,
          })),
        },
      }
    },
  )
  const owner = { scopeID: session.scope.id, sessionID: session.id }
  const keys = parts.map((part) =>
    StoragePath.messagePart(
      Identifier.asScopeID(owner.scopeID),
      Identifier.asSessionID(owner.sessionID),
      Identifier.asMessageID(messageID),
      Identifier.asPartID(part.id),
    ),
  )
  await Storage.transaction((tx) => tx.writeMany(parts.map((value, index) => ({ key: keys[index], value }))))
  return { owner, messageID, parts, keys }
}
const headerKey = (key: string[]) => [...key.slice(0, 3), "attachment_index", key[4], key[6], "header"]

test("historical attachment preparation keeps one writer per bounded page and decodes canonical Parts serially", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await legacyParts(65)
        const revisions = await Storage.revisions(value.keys)
        expect((await Storage.readMany(value.keys.map(headerKey))).every((row) => row === undefined)).toBe(true)
        let writerTransactions = 0
        let bulkBodyReads = 0
        {
          using writers = spyOn(Storage.current().store, "transaction")
          using reads = spyOn(StoreTransaction.prototype, "readMany")
          await SessionAttachmentIndex.migration.upSession!(value.owner, () => {})
          writerTransactions = writers.mock.calls.length
          bulkBodyReads = reads.mock.calls.filter(([keys]) =>
            keys.some((key) => key.length === 7 && key[3] === "messages" && key[5] === "parts"),
          ).length
        }
        console.info(
          "ATTACHMENT_COLD_WRITER_WORK",
          JSON.stringify({ parts: value.parts.length, writerTransactions, bulkBodyReads }),
        )
        expect(writerTransactions).toBeGreaterThan(0)
        expect(writerTransactions).toBeLessThanOrEqual(3)
        expect(bulkBodyReads).toBe(0)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        for (const key of value.keys.slice(0, -1))
          expect(await SessionAttachmentIndex.page(key, {})).toMatchObject({ total: 0, items: [] })
        const files = await SessionAttachmentIndex.page(value.keys.at(-1)!, {})
        expect(files.total).toBe(2)
        expect(files.items.map((item) => item.filename)).toEqual(["one.txt", "two.txt"])
        const display = await SessionHistoryDisplay.partPage(
          { sessionID: value.owner.sessionID, messageID: value.messageID, limit: 100 },
          value.owner.scopeID,
        )
        expect(display.items.map((part) => part.id)).toEqual(value.parts.map((part) => part.id))
        expect(display.generation).toBe(value.parts.length)
        expect(
          (
            await Storage.readMany(
              value.keys.map((key) => StoragePath.sessionTextDirty(key[1], key[2], key[4], key[6])),
            )
          ).every((row) => row !== undefined),
        ).toBe(true)
      },
    }),
  )
}, 30_000)

test("a rejected historical attachment page rolls back its metadata and display maintenance before retry", async () => {
  let rejectedPartID: string | undefined
  const original = new Error("Original attachment page rejected")
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("attachment-cold-page-fault", async (_tx, keys) => {
        if (rejectedPartID && keys.some((key) => key[3] === "attachment_index" && key[5] === rejectedPartID))
          throw original
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await legacyParts(40)
        const revisions = await Storage.revisions(value.keys)
        rejectedPartID = value.parts[36].id
        const result = await SessionAttachmentIndex.migration.upSession!(value.owner, () => {}).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        expect(result.kind).toBe("rejected")
        if (result.kind === "rejected") expect(result.error).toBe(original)
        const headers = await Storage.readMany(value.keys.map(headerKey))
        expect(headers.slice(0, 32).every((row) => row !== undefined)).toBe(true)
        expect(headers.slice(32).every((row) => row === undefined)).toBe(true)
        const displayKeys = value.keys.map((key) => StoragePath.sessionDisplayPart(key[1], key[2], key[4], key[6]))
        const displays = await Storage.readMany(displayKeys)
        expect(displays.slice(0, 32).every((row) => row !== undefined)).toBe(true)
        expect(displays.slice(32).every((row) => row === undefined)).toBe(true)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        rejectedPartID = undefined
        await SessionAttachmentIndex.migration.upSession!(value.owner, () => {})
        expect((await Storage.readMany(value.keys.map(headerKey))).every((row) => row !== undefined)).toBe(true)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
      },
    }),
  )
}, 30_000)
