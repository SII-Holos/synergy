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

test("cold execution reads batch current headers without materializing display records", () =>
  run(async () => {
    const { session, part } = await fixture()
    await Session.updatePart({ ...part, text: "ready from canonical header" })
    const before = await Storage.query({ kind: "display_part", sessionID: session.id })
    using bodies = spyOn(Storage, "readBinary")
    const messages = await SessionHistory.executionMessages({ sessionID: session.id })
    expect(messages[0].parts[0].preview).toBe("ready from canonical header")
    expect(await Storage.query({ kind: "display_part", sessionID: session.id })).toEqual(before)
    expect(bodies).not.toHaveBeenCalled()
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

test("cancelled facts preparation resumes after its committed cursor", () =>
  run(async () => {
    const { session, user, part } = await fixture()
    for (let index = 1; index < 65; index++)
      await Session.updatePartDelta({ ...part, id: Identifier.ascending("part") }, part.text)
    await Session.flushPartWrites(session.id)
    const controller = new AbortController()
    using binary = spyOn(Storage, "readBinary")
    await expect(
      SessionHistory.executionMessages({
        sessionID: session.id,
        signal: controller.signal,
        progress(value) {
          if (value.stage === "parts" && value.prepared >= 32) controller.abort()
        },
      }),
    ).rejects.toThrow()
    const completed = new Set(binary.mock.calls.map(([key]) => JSON.stringify(key)))
    expect(completed.size).toBeGreaterThan(0)
    binary.mockClear()
    const result = await SessionHistory.executionMessages({ sessionID: session.id })
    expect(result.find((message) => message.info.id === user.id)?.parts).toHaveLength(65)
    expect(binary.mock.calls.length).toBeGreaterThan(0)
    expect(binary.mock.calls.some(([key]) => completed.has(JSON.stringify(key)))).toBe(false)
  }))

test("deleting a message during prefix preparation cannot republish its facts", () =>
  run(async () => {
    const { session } = await fixture()
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
    const preparing = SessionHistory.executionMessages({ sessionID: session.id })
    const settled = preparing.catch((error: unknown) => error)
    try {
      await reached.promise
      await Session.remove(session.id)
    } finally {
      release.resolve()
    }
    expect(await settled).toEqual([])
    await expect(Session.get(session.id)).rejects.toThrow()
  }))
