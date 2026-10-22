import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionCorpus } from "../../src/session/corpus"
import { MessageV2 } from "../../src/session/message-v2"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { UpgradeWork } from "../../src/storage/upgrade-work"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("corpus queries page past other origins, hydrate versioned text and reject edited evidence", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await UpgradeWork.control("resume")
        const session = await Session.create({})
        let target: MessageV2.Part | undefined
        for (let i = 0; i < 38; i++) {
          const id = Identifier.ascending("message")
          await Session.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            rootID: id,
            time: { created: i },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            origin: { type: i === 37 ? "user" : "agent" },
          })
          target = await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: id,
            sessionID: session.id,
            type: "text",
            text: "修改架构 API design",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: id,
            sessionID: session.id,
            type: "reasoning",
            time: { start: 1, end: 2 },
            text: "excluded reasoning".repeat(5000),
          })
        }
        const original = StoreTransaction.prototype.versioned
        const loaded: string[][] = []
        const reading = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          loaded.push(key)
          return original.call(this, key) as ReturnType<typeof original<T>>
        })
        try {
          let cursor: SessionCorpus.PreparationCursor | undefined
          for (;;) {
            const page = await SessionCorpus.prepare({ scopeID: session.scope.id, sessionID: session.id, cursor })
            if (page.ready) break
            cursor = page.cursor
          }
        } finally {
          reading.mockRestore()
        }
        expect(loaded.filter((key) => key[5] === "parts")).toHaveLength(38)
        const page = await SessionCorpus.query({
          terms: ["架构", "design"],
          roles: ["user"],
          origins: ["user"],
          limit: 1,
        })
        expect(page.items).toHaveLength(1)
        const ref = page.items[0]!.reference
        const [message] = await SessionCorpus.hydrate([ref])
        expect(message?.text).toBe("修改架构 API design")
        expect(message?.parts.every((part) => part.type === "text")).toBe(true)
        await Session.updatePart({
          id: target!.id,
          messageID: target!.messageID,
          sessionID: session.id,
          type: "text",
          text: "new version",
        })
        expect(await SessionCorpus.hydrate([ref])).toEqual([undefined])
        await Session.remove(session.id)
        expect(await SessionCorpus.hydrate([ref])).toEqual([undefined])
      },
    })
  }))
