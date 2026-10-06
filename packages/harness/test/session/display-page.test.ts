import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

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
