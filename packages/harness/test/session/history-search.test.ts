import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { UpgradeWork } from "../../src/storage/upgrade-work"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test(
  "explicit history search finishes selected indexing while background import is paused",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await UpgradeWork.control("pause")
          const session = await Session.create({ title: "Requested search" })
          const unrelated = await Session.create({ title: "Cold search" })
          try {
            const messageID = Identifier.ascending("message")
            await Session.updateMessage({
              id: messageID,
              sessionID: session.id,
              role: "user",
              time: { created: 1 },
              isRoot: true,
              visible: true,
              agent: "synergy",
              model: { providerID: "test", modelID: "test" },
            })
            for (let index = 0; index < 40; index++)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID,
                sessionID: session.id,
                type: "text",
                text: `Question ${index}`,
              })
            const foreign = StoragePath.sessionTextState(unrelated.scope.id, unrelated.id)
            const before = await Storage.readMany([foreign])
            const first = await SessionHistory.search({ sessionID: session.id, query: "Question 39" })
            expect(first.preparing).toBe(true)
            const until = performance.now() + 5000
            let ready = false
            while (!ready && performance.now() < until) {
              const [state] = await Storage.readMany<{ ready: boolean }>([
                StoragePath.sessionTextState(session.scope.id, session.id),
              ])
              ready = state?.ready === true
              if (!ready) await Bun.sleep(20)
            }
            expect(ready).toBe(true)
            expect((await SessionHistory.search({ sessionID: session.id, query: "Question 39" })).items).toHaveLength(1)
            expect(await Storage.readMany([foreign])).toEqual(before)
            expect((await UpgradeWork.status()).paused).toBe(true)
          } finally {
            await Session.remove(session.id)
            await Session.remove(unrelated.id)
          }
        },
      })
    }),
  15000,
)

test("full conversation text reads one effective history snapshot while another input updates a Part", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Consistent full copy" })
        const messages = [Identifier.ascending("message"), Identifier.ascending("message")]
        const parts = [Identifier.ascending("part"), Identifier.ascending("part")]
        for (let i = 0; i < 2; i++) {
          await Session.updateMessage({
            id: messages[i]!,
            sessionID: session.id,
            role: "user",
            time: { created: i + 1 },
            isRoot: true,
            visible: true,
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
          })
          await Session.updatePart({
            id: parts[i]!,
            messageID: messages[i]!,
            sessionID: session.id,
            type: "text",
            text: i ? "second original" : "first original",
          })
        }
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const records = Storage.records
        const paused = spyOn(Storage, "records").mockImplementation(async function* <T>(
          input?: Parameters<typeof records>[0],
        ) {
          for await (const record of records<T>(input)) {
            if (input?.kind === "part" && input.messageID === messages[0]) {
              started.resolve()
              await release.promise
            }
            yield record
          }
        })
        try {
          const copying = SessionHistory.text({ sessionID: session.id })
          await started.promise
          await Session.updatePart({
            id: parts[1]!,
            messageID: messages[1]!,
            sessionID: session.id,
            type: "text",
            text: "second updated",
          })
          release.resolve()
          expect(await copying).toBe("first original\n\nsecond original")
        } finally {
          release.resolve()
          paused.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  }))

test("full copy preserves assistant reasoning fallback and omits synthetic text", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Full copy" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: Identifier.ascending("message"),
          time: { created: 1 },
          providerID: "test",
          modelID: "test",
          mode: "build",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "reasoning",
          text: "原始推理",
          time: { start: 1, end: 2 },
        })
        expect(await SessionHistory.text({ sessionID: session.id, messageID })).toBe("原始推理")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "text",
          text: "隐藏系统文本",
          synthetic: true,
        })
        expect(await SessionHistory.text({ sessionID: session.id, messageID })).toBe("")
        expect(await SessionHistory.text({ sessionID: session.id, messageID, reasoning: true })).toBe("原始推理")
        await Session.remove(session.id)
      },
    })
  }))

test("full history search indexes original Parts incrementally and excludes rollback and system content", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Search history" })
        const first = Identifier.ascending("message")
        const second = Identifier.ascending("message")
        for (const [id, time] of [
          [first, 100],
          [second, 200],
        ] as const)
          await Session.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            time: { created: time },
            isRoot: true,
            visible: true,
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
          })
        const textID = Identifier.ascending("part")
        await Session.updatePart({
          id: textID,
          messageID: first,
          sessionID: session.id,
          type: "text",
          text: "开头正文 中文搜索",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: first,
          sessionID: session.id,
          type: "text",
          text: "隐藏系统关键词",
          synthetic: true,
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: first,
          sessionID: session.id,
          type: "reasoning",
          text: "推理正文 额外关键词",
          time: { start: 1, end: 2 },
        })
        const toolID = Identifier.ascending("part")
        await Session.updatePart({
          id: toolID,
          messageID: second,
          sessionID: session.id,
          type: "tool",
          tool: "test",
          callID: "test",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(180_000) + "末尾工具关键词",
            title: "Large",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        let page = await SessionHistory.search({ sessionID: session.id, query: "中文搜索" })
        for (let batch = 0; page.preparing && batch < 100; batch++)
          page = await SessionHistory.search({ sessionID: session.id, query: "中文搜索" })
        expect(page.preparing).toBe(false)
        expect(page.items.map((item) => item.partID)).toEqual([textID])
        expect((await SessionHistory.search({ sessionID: session.id, query: "隐藏系统关键词" })).items).toEqual([])
        expect((await SessionHistory.search({ sessionID: session.id, query: "额外关键词" })).items).toEqual([])
        expect(
          (await SessionHistory.search({ sessionID: session.id, query: "额外关键词", reasoning: true })).items,
        ).toHaveLength(1)
        expect(
          (await SessionHistory.search({ sessionID: session.id, query: "末尾工具关键词", tools: true })).items.map(
            (item) => item.partID,
          ),
        ).toEqual([toolID])
        await Session.updatePart({
          id: textID,
          messageID: first,
          sessionID: session.id,
          type: "text",
          text: "更新正文",
        })
        page = await SessionHistory.search({ sessionID: session.id, query: "中文搜索" })
        expect(page.items).toEqual([])
        for (let batch = 0; page.preparing && batch < 20; batch++)
          page = await SessionHistory.search({ sessionID: session.id, query: "更新正文" })
        expect(page.items.map((item) => item.partID)).toEqual([textID])
        const historyID = Identifier.ascending("history")
        await Storage.write(
          StoragePath.sessionHistoryEvent(
            Identifier.asScopeID(session.scope.id),
            Identifier.asSessionID(session.id),
            historyID,
          ),
          {
            id: historyID,
            sessionID: session.id,
            type: "rollback",
            time: { created: 300 },
            numTurns: 1,
            cutMessageID: second,
            droppedMessageIDs: [second],
            droppedUserMessageIDs: [second],
            files: [],
            patchPartIDs: [],
          } satisfies SessionHistory.RollbackEvent,
        )
        expect(
          (await SessionHistory.search({ sessionID: session.id, query: "末尾工具关键词", tools: true })).items,
        ).toEqual([])
        await Session.removePart({ sessionID: session.id, messageID: first, partID: textID })
        expect((await SessionHistory.search({ sessionID: session.id, query: "更新正文" })).items).toEqual([])
        await Session.remove(session.id)
      },
    })
  }))
