import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { SqlConnection, SqlTransactionOptions } from "../../src/storage/sql-contract"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function countWriterTransactions(onWrite: () => void) {
  const transaction = SqliteDriver.prototype.transaction
  return spyOn(SqliteDriver.prototype, "transaction").mockImplementation(function <T>(
    this: SqliteDriver,
    body: (connection: SqlConnection) => Promise<T>,
    options?: SqlTransactionOptions,
  ): Promise<T> {
    if (!options?.readOnly) onWrite()
    return transaction.call(this, body, options) as Promise<T>
  })
}

test("reasoning without readable text retains its evidence but has no display entrance", () => {
  for (const text of ["", " \n\t", "Readable reasoning"]) {
    const part: MessageV2.ReasoningPart = {
      id: "prt_reasoning",
      messageID: "msg_assistant",
      sessionID: "ses_test",
      type: "reasoning",
      text,
      time: { start: 1, end: 2 },
      metadata: { "test-provider": { reasoningEncryptedContent: "opaque-evidence" } },
    }
    const before = JSON.stringify(part)
    const summary = MessageV2.summarizePart(part)
    expect(summary.render).toBe(text.trim().length > 0)
    expect(summary.content.bytes).toBe(Buffer.byteLength(before))
    expect(JSON.stringify(part)).toBe(before)
  }
})

test("reasoning summaries carry only the provider item identity and preserve canonical content references", () => {
  const part: MessageV2.ReasoningPart = {
    id: "summary-0",
    sessionID: "session",
    messageID: "assistant",
    type: "reasoning",
    text: "First summary",
    time: { start: 1, end: 2 },
    metadata: { "openai-codex": { itemId: "rs_shared", reasoningEncryptedContent: "private-payload" } },
  }
  const summary = MessageV2.summarizePart(part)
  expect(summary.reasoningKey).toBe(JSON.stringify(["openai-codex", "rs_shared"]))
  expect(JSON.stringify(summary)).not.toContain("private-payload")
  expect(summary.content.version).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(part)).digest("hex"))
  expect(MessageV2.summarizePart({ ...part, metadata: undefined }).reasoningKey).toBeUndefined()
  expect(
    MessageV2.summarizePart({ ...part, metadata: { "openai-codex": { itemId: "" } } }).reasoningKey,
  ).toBeUndefined()
  expect(MessageV2.summarizePart({ ...part, text: " \n " }).render).toBe(false)
  expect(summary.render).toBe(true)
})

test("large provider diagnostics stay out of display headers without changing canonical evidence", () => {
  const info: MessageV2.Assistant = {
    id: "msg_assistant",
    sessionID: "ses_test",
    role: "assistant",
    parentID: "msg_user",
    time: { created: 1 },
    modelID: "model",
    providerID: "provider",
    path: { cwd: null, root: null },
    mode: "synergy",
    agent: "synergy",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error: {
      name: "APIError",
      data: {
        message: "错误详情".repeat(100_000),
        responseBody: "body".repeat(100_000),
        responseHeaders: { diagnostic: "header".repeat(100_000) },
        metadata: { diagnostic: "metadata".repeat(100_000) },
        statusCode: 500,
        isRetryable: true,
      },
    },
  }
  const header = SessionHistoryDisplay.summarizeMessage(info)
  expect(Buffer.byteLength(JSON.stringify(header))).toBeLessThan(32 * 1024)
  expect(header.info.role === "assistant" && header.info.error).toMatchObject({
    name: "APIError",
    data: { statusCode: 500, isRetryable: true },
  })
  expect(info.error?.name === "APIError" && info.error.data.responseBody?.length).toBe(400_000)
  expect(header.content.bytes).toBeGreaterThan(1024 * 1024)
})

test("header projection keeps compact change metadata and resolves full originals by version", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Header content" })
        const info: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          referenceContext: { state: "none" },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
          isRoot: true,
          visible: true,
          origin: { type: "channel", label: "channel", detail: "历史来源".repeat(100_000) },
          system: "system".repeat(100_000),
          metadata: { promptDraft: "draft".repeat(100_000) },
          summary: {
            title: "摘要标题".repeat(100_000),
            body: "摘要正文".repeat(100_000),
            diffs: [
              {
                file: "source.ts",
                operationID: "operation",
                additions: 3,
                deletions: 1,
                binary: false,
                patch: "patch".repeat(100_000),
              },
            ],
          },
        }
        const canonical = await MessageV2.writeInfo({ scopeID: Identifier.asScopeID(session.scope.id), info })
        const page = await SessionHistory.timelinePage({ sessionID: session.id })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024)
        expect(page.items[0].info).toMatchObject({
          summary: { diffs: [{ file: "source.ts", additions: 3, deletions: 1 }] },
        })
        const original = await SessionHistory.messageDetails({
          sessionID: session.id,
          messageID: info.id,
          version: page.items[0].content.version,
        })
        expect(original.info).toEqual(canonical)
        await MessageV2.writeInfo({
          scopeID: Identifier.asScopeID(session.scope.id),
          info: { ...info, metadata: { promptDraft: "changed" } },
        })
        await expect(
          SessionHistory.messageDetails({
            sessionID: session.id,
            messageID: info.id,
            version: page.items[0].content.version,
          }),
        ).rejects.toThrow()
        await MessageV2.removeInfo({
          scopeID: Identifier.asScopeID(session.scope.id),
          sessionID: Identifier.asSessionID(session.id),
          messageID: Identifier.asMessageID(info.id),
        })
        expect((await SessionHistory.timelinePage({ sessionID: session.id })).items).toEqual([])
        await Session.remove(session.id)
      },
    })
  }))

test("batched part pages bound a message window with the same semantics as single pages", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Batch part pages" })
        const messages: { id: string; partIDs: string[] }[] = []
        for (let index = 0; index < 3; index++) {
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: index + 1 },
            isRoot: true,
            visible: true,
          })
          const partIDs = Array.from({ length: index + 2 }, () => Identifier.ascending("part"))
          await Storage.transaction((tx) =>
            tx.writeMany(
              partIDs.map((partID, part) => ({
                key: StoragePath.messagePart(
                  Identifier.asScopeID(session.scope.id),
                  Identifier.asSessionID(session.id),
                  messageID,
                  Identifier.asPartID(partID),
                ),
                value: {
                  id: partID,
                  messageID,
                  sessionID: session.id,
                  type: "text" as const,
                  text: `m${index} p${part}`,
                },
              })),
            ),
          )
          messages.push({ id: messageID, partIDs })
        }
        const result = await SessionHistory.partPages({
          sessionID: session.id,
          messageIDs: messages.map((message) => message.id),
          limit: 100,
        })
        expect(Object.keys(result)).toEqual(messages.map((message) => message.id))
        messages.forEach((message) => {
          expect(result[message.id].items.map((part) => part.id)).toEqual(message.partIDs)
          expect(result[message.id].hasMore).toBe(false)
          expect(result[message.id].hasEarlier).toBe(false)
          expect(result[message.id].nextCursor).toBeNull()
        })
        await expect(
          SessionHistory.partPages({ sessionID: session.id, messageIDs: [messages[0].id, "msg_missing"] }),
        ).rejects.toThrow()
        await Session.remove(session.id)
      },
    })
  }))

test("historical Part projection resumes across pages and excludes deleted content", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Historical Parts" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
          isRoot: true,
          visible: true,
        })
        await Storage.remove(["sessions", session.scope.id, session.id, "display_parts_state", messageID])
        const parts = Array.from({ length: 120 }, (_, index) => ({
          id: `prt_${index.toString(16).padStart(26, "0")}`,
          messageID,
          sessionID: session.id,
          type: "text" as const,
          text: `original ${index}`,
        }))
        await Storage.transaction((tx) =>
          tx.writeMany(
            parts.map((part) => ({
              key: StoragePath.messagePart(
                Identifier.asScopeID(session.scope.id),
                Identifier.asSessionID(session.id),
                messageID,
                Identifier.asPartID(part.id),
              ),
              value: part,
            })),
          ),
        )
        const first = await SessionHistory.partPage({ sessionID: session.id, messageID })
        expect(first.items).toHaveLength(100)
        const second = await SessionHistory.partPage({ sessionID: session.id, messageID, cursor: first.nextCursor! })
        expect(second.items).toHaveLength(20)
        const query = Storage.query
        using noBodies = spyOn(Storage, "query").mockImplementation(async (input) => {
          if (input.kind === "part") throw new Error("canonical reads are unavailable")
          return query(input)
        })
        expect((await SessionHistory.partPage({ sessionID: session.id, messageID })).items).toHaveLength(100)
        const target = await SessionHistory.partPage({
          sessionID: session.id,
          messageID,
          partID: parts[118].id,
          limit: 10,
        })
        expect(target.items.map((part) => part.id)).toEqual(parts.slice(109, 119).map((part) => part.id))
        expect(target.hasEarlier).toBe(true)
        expect(target.hasMore).toBe(true)
        const preceding = await SessionHistory.partPage({
          sessionID: session.id,
          messageID,
          cursor: target.previousCursor!,
          older: true,
          limit: 10,
        })
        expect(preceding.items.map((part) => part.id)).toEqual(parts.slice(99, 109).map((part) => part.id))
        await Session.removePart({ sessionID: session.id, messageID, partID: parts[0].id })
        expect((await SessionHistory.partPage({ sessionID: session.id, messageID })).items[0].id).toBe(parts[1].id)
        await Session.removeMessage({ sessionID: session.id, messageID })
        await expect(
          SessionHistory.partContent({ sessionID: session.id, messageID, partID: parts[1].id }),
        ).rejects.toThrow()
        await Session.remove(session.id)
      },
    })
  }))

test("timeline preparation preserves canonical settlement state after rereading stored messages", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Canonical settlement projection" })
        const expired: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
          isRoot: true,
          visible: true,
          summary: { diffs: [], diffState: { status: "pending", deadlineAt: 1 } },
        }
        const pending: MessageV2.User = {
          ...expired,
          id: Identifier.ascending("message"),
          time: { created: 2 },
          summary: { diffs: [], diffState: { status: "pending", deadlineAt: Number.MAX_SAFE_INTEGER } },
        }
        for (const info of [expired, pending]) {
          await Session.updateMessage(info)
          await Storage.write(
            StoragePath.messageInfo(session.scope.id, session.id, Identifier.asMessageID(info.id)),
            info,
          )
        }
        const state = async (messageID: string) => {
          const page = await SessionHistory.timelinePage({ sessionID: session.id })
          const info = page.items.find((item) => item.info.id === messageID)!.info
          expect(info.role).toBe("user")
          return info.role === "user" ? info.summary?.diffState : undefined
        }
        expect(await state(expired.id)).toEqual({ status: "error", code: "timeout" })
        expect(await state(pending.id)).toEqual(pending.summary!.diffState)
        await SessionHistoryDisplay.prepareWindow(session.scope.id, session.id, [expired])
        expect(await state(expired.id)).toEqual({ status: "error", code: "timeout" })
        await Storage.transaction(async () => {
          await SessionHistoryDisplay.prepareWindow(session.scope.id, session.id, [expired])
          expect(await state(expired.id)).toEqual({ status: "error", code: "timeout" })
        })
        const stored = await Storage.read<MessageV2.User>(
          StoragePath.messageInfo(session.scope.id, session.id, Identifier.asMessageID(expired.id)),
        )
        expect(stored.summary?.diffState).toEqual(expired.summary!.diffState)
        await Session.remove(session.id)
      },
    })
  }))

test("display pages seek chronology, bound summaries, and resolve original bodies separately", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Display history" })
        const ids: string[] = []
        for (const index of [8, 1, 7, 2, 6]) {
          const id = `msg_${index.toString(16).padStart(26, "0")}`
          ids.push(id)
          await Session.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1_000 + ids.length },
            isRoot: true,
            rootID: id,
            visible: true,
            origin: { type: "user" },
          })
        }
        const part = {
          id: Identifier.ascending("part"),
          messageID: ids.at(-1)!,
          sessionID: session.id,
          type: "text" as const,
          text: "中文正文".repeat(100_000),
        }
        await Session.updatePart(part)
        const page = await SessionHistory.timelinePage({ sessionID: session.id, limit: 2 })
        expect(page.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(page.total).toBe(5)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
        using noScan = spyOn(MessageV2, "readInfoList").mockImplementation(async () => {
          throw new Error("complete history read is unavailable")
        })
        const older = await SessionHistory.timelinePage({ sessionID: session.id, cursor: page.nextCursor!, limit: 2 })
        expect(older.items.map((item) => item.info.id)).toEqual(ids.slice(1, 3))
        const parts = await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })
        expect(parts.items[0]?.content.bytes).toBeGreaterThan(500_000)
        expect(parts.items[0]).not.toHaveProperty("text")
        const body = await SessionHistory.partContent({
          sessionID: session.id,
          messageID: part.messageID,
          partID: part.id,
          version: parts.items[0]!.content.version,
        })
        expect(body.part).toMatchObject(part)
        expect(await SessionHistory.text({ sessionID: session.id, messageID: part.messageID })).toBe(part.text)
        const query = Storage.query
        using noBodies = spyOn(Storage, "query").mockImplementation(async (input) => {
          if (input.kind === "part") throw new Error("canonical bodies are unavailable")
          return query(input)
        })
        expect((await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })).items[0]?.id).toBe(
          part.id,
        )
        await Session.removePart({ sessionID: session.id, messageID: part.messageID, partID: part.id })
        expect((await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })).items).toEqual([])
        noScan[Symbol.dispose]()
        const rollbackID = Identifier.ascending("history")
        await Storage.write(
          StoragePath.sessionHistoryEvent(
            Identifier.asScopeID(session.scope.id),
            Identifier.asSessionID(session.id),
            rollbackID,
          ),
          {
            id: rollbackID,
            sessionID: session.id,
            type: "rollback",
            time: { created: 2_000 },
            numTurns: 3,
            droppedMessageIDs: ids.slice(2),
            droppedUserMessageIDs: ids.slice(2),
            cutMessageID: ids[2],
            files: [],
            patchPartIDs: [],
          } satisfies SessionHistory.RollbackEvent,
        )
        const effective = await SessionHistory.timelinePage({ sessionID: session.id })
        expect(effective.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(effective.total).toBe(2)
        expect(await SessionHistory.text({ sessionID: session.id })).toBe("")
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 3_000 },
          isRoot: true,
          visible: true,
          origin: { type: "user" },
        })
        expect(
          (await SessionHistory.timelinePage({ sessionID: session.id })).items.map((item) => item.info.id).slice(0, 2),
        ).toEqual(ids.slice(0, 2))
        expect((await SessionHistory.timelinePage({ sessionID: session.id })).total).toBe(3)
        await Session.remove(session.id)
      },
    })
  }))

test("latest display pages rebuild only a bounded window when the projection is pending", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Bounded display" })
        const ids: string[] = []
        for (let index = 0; index < 140; index++) {
          const id = `msg_${index.toString(16).padStart(26, "0")}`
          ids.push(id)
          await Session.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1_000 + index },
            isRoot: true,
            rootID: id,
            visible: true,
            origin: { type: "user" },
          })
        }
        const scopeID = Identifier.asScopeID(session.scope.id)
        await Storage.removeTree(["sessions", scopeID, session.id, "display_message"])
        await Storage.removeTree(["sessions", scopeID, session.id, "display_timeline"])
        await Storage.removeTree(["sessions", scopeID, session.id, "display_root"])
        await Storage.remove(StoragePath.sessionDisplayState(scopeID, session.id))
        using noFullScan = spyOn(MessageV2, "readInfoList").mockImplementation(async () => {
          throw new Error("timeline page must not read the complete message history")
        })
        const page = await SessionHistory.timelinePage({ sessionID: session.id, limit: 2 })
        expect(page.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(page.total).toBe(ids.length)
        await Session.remove(session.id)
      },
    })
  }))

test("a cold batched part page fan-out materializes the window in a single storage transaction", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Seed one session with cold (unmaterialized) display parts so the
        // batched fan-out drives real materialization work.
        async function seed(title: string) {
          const session = await Session.create({ title })
          const messages: { id: string; partIDs: string[] }[] = []
          for (let index = 0; index < 3; index++) {
            const messageID = Identifier.ascending("message")
            await Session.updateMessage({
              id: messageID,
              sessionID: session.id,
              role: "user",
              agent: "synergy",
              model: { providerID: "test", modelID: "test" },
              time: { created: index + 1 },
              isRoot: true,
              visible: true,
            })
            // Force a cold display_parts projection: Session.updateMessage
            // stamped a ready state over the not-yet-written display_part rows,
            // which would make the fan-out serve empty pages without work.
            await Storage.remove(["sessions", session.scope.id, session.id, "display_parts_state", messageID])
            const partIDs = Array.from({ length: index + 2 }, () => Identifier.ascending("part"))
            await Storage.transaction((tx) =>
              tx.writeMany(
                partIDs.map((partID, part) => ({
                  key: StoragePath.messagePart(
                    Identifier.asScopeID(session.scope.id),
                    Identifier.asSessionID(session.id),
                    messageID,
                    Identifier.asPartID(partID),
                  ),
                  value: {
                    id: partID,
                    messageID,
                    sessionID: session.id,
                    type: "text" as const,
                    text: `seed ${part} of ${index}`,
                  },
                })),
              ),
            )
            messages.push({ id: messageID, partIDs })
          }
          return { session, messages }
        }

        const batched = await seed("Batched cold refresh")

        // Count the real driver writer transactions, not nested Storage calls.
        const requireDisplayMessage = async () => undefined
        let driverTransactions = 0
        using counting = countWriterTransactions(() => driverTransactions++)
        const coldResult = await SessionHistoryDisplay.partPages(
          {
            sessionID: batched.session.id,
            messageIDs: batched.messages.map((message) => message.id),
            limit: 100,
          },
          requireDisplayMessage,
          batched.session.scope.id,
        )
        expect(driverTransactions).toBe(1)
        counting[Symbol.dispose]()

        // The same window resolved message-by-message through the public
        // single-page endpoint yields byte-identical pages: the batch did not
        // change observable projection semantics.
        expect(Object.keys(coldResult)).toEqual(batched.messages.map((message) => message.id))
        for (const message of batched.messages) {
          const single = await SessionHistory.partPage({
            sessionID: batched.session.id,
            messageID: message.id,
            limit: 100,
          })
          expect(coldResult[message.id].items.map((part) => part.id)).toEqual(message.partIDs)
          expect(JSON.parse(JSON.stringify(coldResult[message.id]))).toEqual(JSON.parse(JSON.stringify(single)))
        }

        // Warm Display pages reuse the projection without writer admission.
        driverTransactions = 0
        using recounting = countWriterTransactions(() => driverTransactions++)
        const warmResult = await SessionHistoryDisplay.partPages(
          {
            sessionID: batched.session.id,
            messageIDs: batched.messages.map((message) => message.id),
            limit: 100,
          },
          requireDisplayMessage,
          batched.session.scope.id,
        )
        expect(driverTransactions).toBe(0)
        expect(JSON.parse(JSON.stringify(warmResult))).toEqual(JSON.parse(JSON.stringify(coldResult)))
        recounting[Symbol.dispose]()

        // The public SessionHistory endpoint observes the same page bytes.
        const publicResult = await SessionHistory.partPages({
          sessionID: batched.session.id,
          messageIDs: batched.messages.map((message) => message.id),
          limit: 100,
        })
        expect(JSON.parse(JSON.stringify(publicResult))).toEqual(JSON.parse(JSON.stringify(coldResult)))

        await Session.remove(batched.session.id)
      },
    })
  }))

test("prepareWindow coalesces concurrent callers into shared drain waves per session", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Coalesced window" })
        const scopeID = Identifier.asScopeID(session.scope.id)
        const infos: MessageV2.User[] = []
        for (let index = 0; index < 2; index++) {
          const info: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: index + 1 },
            isRoot: true,
            visible: true,
          }
          // Raw canonical writes keep display headers cold so prepareWindow
          // cannot short-circuit; the drain wave has real work to coalesce.
          await Storage.write(
            StoragePath.messageInfo(scopeID, Identifier.asSessionID(session.id), Identifier.asMessageID(info.id)),
            info,
          )
          infos.push(info)
        }

        let driverTransactions = 0
        using counting = countWriterTransactions(() => driverTransactions++)

        // Enqueue the first drain wave but do not await it yet, so the second
        // caller lands while the wave is still running and attaches to the
        // same shared `running` promise instead of opening its own batch.
        const first = SessionHistoryDisplay.prepareWindow(scopeID, session.id, [infos[0]])
        const second = SessionHistoryDisplay.prepareWindow(scopeID, session.id, [infos[1]])
        await expect(first).resolves.toBeUndefined()
        await expect(second).resolves.toBeUndefined()

        // Both drain waves together share at most one driver transaction each;
        // the coalescing guarantee is that the two concurrent calls never fan
        // out into per-caller concurrent batches.
        expect(driverTransactions).toBeLessThanOrEqual(2)

        for (const info of infos) {
          const header = await SessionHistoryDisplay.header(scopeID, session.id, info.id)
          expect(header?.info.id).toBe(info.id)
        }

        // A settle round-trip proves the coalescer released the session: a new
        // caller runs its own wave instead of hanging on the old promise.
        const info = infos[0]
        await expect(SessionHistoryDisplay.prepareWindow(scopeID, session.id, [info])).resolves.toBeUndefined()
        const settled = await SessionHistoryDisplay.header(scopeID, session.id, info.id)
        expect(settled?.info.id).toBe(info.id)

        await Session.remove(session.id)
      },
    })
  }))

test("overlapping batched part page calls resolve with consistent shared pages and stay idempotent", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Overlapping refresh" })
        const messages: { id: string; partIDs: string[] }[] = []
        for (let index = 0; index < 3; index++) {
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: index + 1 },
            isRoot: true,
            visible: true,
          })
          // Force a cold display_parts projection, as in the cold batch test.
          await Storage.remove(["sessions", session.scope.id, session.id, "display_parts_state", messageID])
          const partIDs = Array.from({ length: index + 2 }, () => Identifier.ascending("part"))
          await Storage.transaction((tx) =>
            tx.writeMany(
              partIDs.map((partID, part) => ({
                key: StoragePath.messagePart(
                  Identifier.asScopeID(session.scope.id),
                  Identifier.asSessionID(session.id),
                  messageID,
                  Identifier.asPartID(partID),
                ),
                value: {
                  id: partID,
                  messageID,
                  sessionID: session.id,
                  type: "text" as const,
                  text: `overlap ${part} of ${index}`,
                },
              })),
            ),
          )
          messages.push({ id: messageID, partIDs })
        }

        let driverTransactions = 0
        using counting = countWriterTransactions(() => driverTransactions++)

        const requireDisplayMessage = async () => undefined
        // Two concurrent overlapping windows refresh the same cold messages at
        // the Display fan-out seam.
        const overlapLeft = SessionHistoryDisplay.partPages(
          { sessionID: session.id, messageIDs: [messages[0].id, messages[1].id], limit: 100 },
          requireDisplayMessage,
          session.scope.id,
        )
        const overlapRight = SessionHistoryDisplay.partPages(
          { sessionID: session.id, messageIDs: [messages[1].id, messages[2].id], limit: 100 },
          requireDisplayMessage,
          session.scope.id,
        )
        const [left, right] = await Promise.all([overlapLeft, overlapRight])

        // Each concurrent call owns exactly one outer batch: two driver
        // transactions total. The overlap must not compound into additional
        // concurrent per-message batches (nested materialization joins the
        // ambient transaction, never the sibling call's).
        expect(driverTransactions).toBe(2)
        counting[Symbol.dispose]()

        // The shared message resolves byte-identically in both overlapping
        // windows: the overlap did not fork divergent refresh output.
        expect(JSON.parse(JSON.stringify(left[messages[1].id]))).toEqual(
          JSON.parse(JSON.stringify(right[messages[1].id])),
        )
        expect(left[messages[1].id].items.map((part) => part.id)).toEqual(messages[1].partIDs)

        // A warm rerun reads the complete window without writer admission.
        driverTransactions = 0
        using recounting = countWriterTransactions(() => driverTransactions++)
        const warm = await SessionHistoryDisplay.partPages(
          { sessionID: session.id, messageIDs: messages.map((message) => message.id), limit: 100 },
          requireDisplayMessage,
          session.scope.id,
        )
        expect(driverTransactions).toBe(0)
        expect(JSON.parse(JSON.stringify(warm[messages[1].id]))).toEqual(
          JSON.parse(JSON.stringify(right[messages[1].id])),
        )
        recounting[Symbol.dispose]()

        await Session.remove(session.id)
      },
    })
  }))
