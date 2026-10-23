import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const run = (fn: () => Promise<void>) => runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))

async function fixture() {
  const session = await Session.create({ workspace: null })
  const rootID = Identifier.ascending("message")
  const user = await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1 },
  })
  const part: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: user.id,
    type: "text",
    text: " ".repeat(16000) + "visible  text\n".repeat(1000),
  }
  await Session.updatePartDelta(part, part.text)
  await Session.flushPartWrites(session.id)
  return { session, user, part }
}

test("execution facts prepare only on demand and warm reads do not hydrate bodies", () =>
  run(async () => {
    const { session, part } = await fixture()
    using bodies = spyOn(MessageV2, "parts")
    const first = await SessionHistory.executionMessages({ sessionID: session.id })
    expect(first[0].info).toMatchObject({ role: "user", isRoot: true, visible: true })
    expect(first[0].parts[0].preview).toBe(part.text.replace(/\s+/g, " ").slice(0, 240))
    expect(bodies).not.toHaveBeenCalled()
    using binary = spyOn(Storage, "readBinary")
    expect(await SessionHistory.executionMessages({ sessionID: session.id })).toEqual(first)
    expect(binary).not.toHaveBeenCalled()
    const page = await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })
    expect(page.items[0]).not.toHaveProperty("execution")
  }))

test("facts publication is fenced against replacement and ordinary Part backfill", () =>
  run(async () => {
    const { session, part } = await fixture()
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
    const preparation = SessionHistory.executionMessages({ sessionID: session.id })
    try {
      await reached.promise
      await Session.updatePart({ ...part, text: "new version" })
      await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })
    } finally {
      release.resolve()
    }
    expect((await preparation)[0].parts[0].preview).toBe("new version")
  }))
