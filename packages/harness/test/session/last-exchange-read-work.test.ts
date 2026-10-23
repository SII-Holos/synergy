import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { PartContent } from "../../src/session/part-content"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const run = (fn: () => Promise<void>) => runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))

async function fixture(texts: string[]) {
  const session = await Session.create({ workspace: null })
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    sessionID: session.id,
    role: "user",
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
    isRoot: true,
    rootID: id,
    visible: true,
    origin: { type: "user" },
  })
  const parts: MessageV2.TextPart[] = []
  for (const text of texts) {
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: id,
      sessionID: session.id,
      type: "text",
      text,
    }
    await Session.updatePartDelta(part, text)
    await Session.flushPartWrites(session.id)
    parts.push(part)
  }
  return { session, parts }
}

test.each(
  [
    [" ".repeat(9000) + "hello", "\n world "],
    ["x".repeat(198) + "  ", "tail"],
    ["  \ud83d", "\ude80\ud800end\udfff  "],
    ["\n\t".repeat(9000)],
    ["x".repeat(199) + "🚀" + "tail"],
  ].map((texts) => [texts] as const),
)("last exchange matches exact joined trim semantics for chunked text", (texts) =>
  run(async () => {
    const { session, parts } = await fixture(texts)
    using bodies = spyOn(MessageV2, "parts")
    await Session.updateLastExchange(session.id)
    expect((await Session.get(session.id)).lastExchange).toEqual({
      user: MessageV2.extractText(parts, { maxLength: 200 }) || undefined,
    })
    expect(bodies).not.toHaveBeenCalled()
  }),
)

test("last exchange reads artifacts outside SQL transactions and preserves concurrent edits", () =>
  run(async () => {
    const { session, parts } = await fixture(["x".repeat(10000)])
    const other = await Session.create({ workspace: null })
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const read = Storage.readBinary
    let first = true
    using binary = spyOn(Storage, "readBinary").mockImplementation(async (key) => {
      expect(Storage.inTransaction()).toBe(false)
      if (first) {
        first = false
        reached.resolve()
        await release.promise
      }
      return read(key)
    })
    const update = Session.updateLastExchange(session.id)
    try {
      await reached.promise
      await Session.update(other.id, (draft) => {
        draft.title = "independent write"
      })
      await Session.update(session.id, (draft) => {
        draft.title = "concurrent title"
      })
      await Session.updatePart({ ...parts[0], text: "replacement" })
    } finally {
      release.resolve()
    }
    await update
    expect(await Session.get(session.id)).toMatchObject({
      title: "concurrent title",
      lastExchange: { user: "replacement" },
    })
    expect((await Session.get(other.id)).title).toBe("independent write")
  }))

test("preview failure never becomes empty history", () =>
  run(async () => {
    const { session } = await fixture(["x".repeat(10000)])
    using binary = spyOn(Storage, "readBinary").mockRejectedValue(new Error("read failed"))
    await expect(Session.updateLastExchange(session.id)).rejects.toThrow("read failed")
    expect((await Session.get(session.id)).lastExchange).toBeUndefined()
  }))

test.each(["new message", "new part", "remove part", "delete session"])(
  "preview retries changed membership: %s",
  (change) =>
    run(async () => {
      const { session, parts } = await fixture([" ".repeat(10000)])
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const read = Storage.readBinary
      let first = true
      using binary = spyOn(Storage, "readBinary").mockImplementation(async (key) => {
        if (first) {
          first = false
          reached.resolve()
          await release.promise
        }
        return read(key)
      })
      const update = Session.updateLastExchange(session.id)
      try {
        await reached.promise
        if (change === "delete session") await Session.remove(session.id)
        else if (change === "remove part")
          await Session.removePart({ sessionID: session.id, messageID: parts[0].messageID, partID: parts[0].id })
        else {
          let messageID = parts[0].messageID
          if (change === "new message") {
            const previous = await MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID })
            messageID = Identifier.ascending("message")
            await Session.updateMessage({ ...previous, id: messageID, rootID: messageID, time: { created: 2 } })
          }
          await Session.updatePart({ ...parts[0], id: Identifier.ascending("part"), messageID, text: "new text" })
        }
      } finally {
        release.resolve()
      }
      await update
      if (change === "delete session") await expect(Session.get(session.id)).rejects.toThrow()
      else
        expect((await Session.get(session.id)).lastExchange).toEqual(
          change === "remove part" ? {} : { user: "new text" },
        )
    }),
)

test("preview rejects an inherited transaction", () =>
  run(async () => {
    const { session } = await fixture(["test"])
    await expect(Storage.transaction(() => Session.updateLastExchange(session.id))).rejects.toThrow(
      "outside a storage transaction",
    )
  }))

test("normalized preview keeps whitespace across chunk boundaries", () =>
  run(async () => {
    const { session } = await fixture([" \t".repeat(6000) + "hello  \n world" + " z".repeat(200)])
    const records = await Array.fromAsync(MessageV2.partRecords({ scopeID: session.scope.id, sessionID: session.id }))
    const part = await MessageV2.parts({ sessionID: session.id, messageID: records[0].value.messageID })
    if (part[0].type !== "text") throw new Error("Expected text")
    expect(await PartContent.prefix(records, { maxLength: 240, normalizeWhitespace: true })).toBe(
      part[0].text.replace(/\s+/g, " ").trim().slice(0, 240),
    )
  }))
