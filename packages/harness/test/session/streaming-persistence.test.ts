import { expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Identifier } from "../../src/id/id"
import { Asset } from "../../src/asset/asset"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionHistory } from "../../src/session/history"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { SessionHistorySearch } from "../../src/session/history-search"
import { PartContent } from "../../src/session/part-content"
import { PartWriteBuffer } from "../../src/session/part-write-buffer"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import type { StoreTransaction, TransactionOptions } from "../../src/storage/transactional-store"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransfer } from "../../src/session/transfer"
import { RecordCodec } from "../../src/storage/record-codec"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { z } from "zod"
import * as MarkdownAssets from "@ericsanchezok/synergy-util/markdown-assets"

test.each([64, 128])("streaming %i flushes encodes new text rather than every accumulated prefix", async (flushes) => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          agent: "streaming-fixture",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
          isRoot: true,
          rootID: messageID,
          visible: true,
          origin: { type: "user" },
        })
        const part: MessageV2.TextPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "text",
          text: "",
        }
        const chunk = "x".repeat(16 * 1024)
        let encodedBytes = 0
        let binaryBytes = 0
        const encode = RecordCodec.encode
        using encoding = spyOn(RecordCodec, "encode").mockImplementation((value, container) => {
          encodedBytes += Buffer.byteLength(JSON.stringify(value))
          return encode(value, container)
        })
        const prepare = Storage.prepareBinary
        using binaries = spyOn(Storage, "prepareBinary").mockImplementation((key, bytes) => {
          binaryBytes += bytes.byteLength
          return prepare(key, bytes)
        })
        for (let index = 0; index < flushes; index++) {
          part.text += chunk
          await Session.updatePartDelta(part, chunk)
          await Session.flushPartWrites(session.id)
        }
        const outputBytes = Buffer.byteLength(part.text)
        console.info(JSON.stringify({ flushes, outputBytes, encodedBytes, binaryBytes }))
        expect(encodedBytes).toBeLessThan(outputBytes * 3 + flushes * 8192)
        expect(encodedBytes + binaryBytes).toBeLessThan(outputBytes * 3 + flushes * 8192)
        const stored = await MessageV2.parts({ sessionID: session.id, messageID })
        expect(stored).toEqual([part])
        await Session.updatePart({ ...part, text: part.text + "\ncompleted" })
        expect(await MessageV2.parts({ sessionID: session.id, messageID })).toEqual([
          { ...part, text: part.text + "\ncompleted" },
        ])
      },
    }),
  )
})

async function streamFixture(text = "") {
  const session = await Session.create({ workspace: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    agent: "streaming-fixture",
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: 1 },
    isRoot: true,
    rootID: messageID,
    visible: true,
    origin: { type: "user" },
  })
  const part: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "text",
    text,
  }
  const key = StoragePath.messagePart(
    Identifier.asScopeID(session.scope.id),
    Identifier.asSessionID(session.id),
    Identifier.asMessageID(messageID),
    Identifier.asPartID(part.id),
  )
  return { session, part, key }
}

async function inHome(body: () => Promise<void>) {
  await using runtime = await testRuntime()
  await runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn: body }))
}

test("stream checkpoints preserve split pairs, lone surrogates, nonempty prefix and exact JSON sizes", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("initial ")
    for (const delta of ["\ud83d", "\ude80", "\ud800", "text", "\udfff", '\n"\\\u0000']) {
      part.text += delta
      await Session.updatePartDelta(part, delta)
      await Session.flushPartWrites(session.id)
      const stored = await PartContent.read(key)
      expect(stored.part).toEqual(part)
      expect(stored.summary.content.bytes).toBe(Buffer.byteLength(JSON.stringify(part)))
      expect(stored.summary.preview).toBe(part.text.slice(0, 256))
      expect(stored.summary.content.version).toStartWith("part-content:1:")
      expect(await Storage.queryKeys({ kind: "part", sessionID: session.id })).toEqual([key])
      expect(await Storage.read(key)).not.toHaveProperty("text")
    }
    expect(await SessionHistory.text({ sessionID: session.id })).toBe(part.text)
    expect((await SessionHistory.effectiveMessageInfos(session))[0]!.visible).toBe(true)
    const replacement = { ...part, text: "plugin replacement" }
    await Session.updatePart(replacement)
    expect(await Storage.read(key)).toEqual(replacement)
    const artifacts = await Storage.snapshot(async (tx) => Array.fromAsync(tx.artifacts()))
    expect(artifacts.filter((entry) => entry.key.includes(part.id))).toEqual([])
    await Session.removePart({ sessionID: session.id, messageID: part.messageID, partID: part.id })
    await Session.flushPartWrites(session.id)
    expect(await Storage.readMany([key])).toEqual([undefined])
  }))

test("streaming summaries retain canonical Markdown references across every split", () =>
  inHome(async () => {
    const image = "asset://0123456789abcdef.png"
    const document = "asset://fedcba9876543210.docx"
    for (const text of [
      `![chart](${image}) [page](${document}#page=2)`,
      `![chart](${image})\n[Word][report]\n\n[report]: ${document}`,
      `\`![chart](${image})\`\n\n\`\`\`md\n![chart](${image})\n\`\`\`\n\n${document}`,
      `![bad](asset://../secret) [site](https://example.org) ![a](${image}) ![b](${image})`,
      `<${image}>`,
    ]) {
      const { session, part, key } = await streamFixture()
      for (const delta of text) {
        part.text += delta
        await Session.updatePartDelta(part, delta)
      }
      await Session.flushPartWrites(session.id)
      const actual = (await PartContent.read(key)).summary
      const expected = MessageV2.summarizePart(part)
      expect(actual.references).toEqual(expected.references)
      expect(actual.content.bytes).toBe(expected.content.bytes)
    }
  }))

test("unobserved small deltas do not repeatedly lex the growing Markdown reference prefix", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture()
    using parses = spyOn(MarkdownAssets, "markdownAssetReferences")
    const first = "![chart](asset://0123456789abcdef.png)"
    part.text = first
    await Session.updatePartDelta(part, first)
    for (let index = 0; index < 512; index++) {
      const delta = "\nsmall text"
      part.text += delta
      await Session.updatePartDelta(part, delta)
    }
    expect(parses).not.toHaveBeenCalled()
    await Session.flushPartWrites(session.id)
    expect(parses).toHaveBeenCalledTimes(1)
    expect((await PartContent.read(key)).summary.references).toEqual(["asset://0123456789abcdef.png"])
  }))

test("short streaming checkpoints do not prepare binary bodies and preserve exact replacement content", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture()
    using prepares = spyOn(Storage, "prepareBinary")
    for (const delta of ["short ", "streaming ", "output", "\ud83d"]) {
      part.text += delta
      await Session.updatePartDelta(part, delta)
      await Session.flushPartWrites(session.id)
    }
    expect((await PartContent.read(key)).part).toEqual(part)
    expect(prepares).not.toHaveBeenCalled()
    for (const delta of ["\ude80" + "x".repeat(4096), " tail"]) {
      part.text += delta
      await Session.updatePartDelta(part, delta)
      await Session.flushPartWrites(session.id)
      const stored = await PartContent.read(key)
      expect(stored.part).toEqual(part)
      expect(stored.summary.content.bytes).toBe(Buffer.byteLength(JSON.stringify(part)))
    }
    expect(prepares).toHaveBeenCalledTimes(2)
    await Session.updatePart({ ...part, text: "terminal output" })
    expect((await PartContent.read(key)).part).toMatchObject({ text: "terminal output" })
  }))

test("one large flush publishes bounded blocks and hydrates their exact content", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("multi-block🚀" + "x".repeat(3 * 1024 * 1024))
    using prepares = spyOn(Storage, "prepareBinary")
    await Session.updatePartDelta(part, part.text)
    await Session.flushPartWrites(session.id)
    expect(prepares).toHaveBeenCalledTimes(4)
    expect(prepares.mock.calls.every(([, bytes]) => bytes.byteLength <= 2 * 1024 * 1024)).toBe(true)
    expect((await PartContent.read(key)).part).toEqual(part)
  }))

test("deduplication rejects a reused append identity with different input and an older settled batch", () =>
  inHome(async () => {
    const { part, key } = await streamFixture("short")
    let first: PartContent.Batch | undefined
    const buffer = new PartWriteBuffer(async (path, batch, guard) => {
      first ??= batch
      await PartContent.append(path, batch, guard, async () => {})
    }, 10_000)
    buffer.defer(part.id, key, part, part.text)
    await buffer.flushAll()
    if (!first) throw new Error("Missing append batch")
    const original = await Storage.versioned(key)
    await expect(
      PartContent.append(
        key,
        { ...first, text: "SHORT", requestHash: undefined },
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("receipt does not match")
    expect(await Storage.versioned(key)).toEqual(original)
    part.text += " newer"
    buffer.defer(part.id, key, part, " newer")
    await buffer.flushAll()
    await expect(
      PartContent.append(
        key,
        first,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("no longer matches")
    expect((await PartContent.read(key)).part).toEqual(part)
    buffer.cancelWhere(() => true)
  }))

test("cold summary pages never hydrate and a Part body snapshot keeps its head, version and chunks together", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("original".repeat(1024))
    await Session.updatePartDelta(part, part.text)
    await Session.flushPartWrites(session.id)
    await Storage.removeTree(["sessions", session.scope.id, session.id, "display_parts_state"])
    const readBinary = Storage.readBinary
    using reading = spyOn(Storage, "readBinary").mockImplementation(async () => {
      throw new Error("body read on summary page")
    })
    const page = await SessionHistoryDisplay.partPage(
      { sessionID: session.id, messageID: part.messageID },
      session.scope.id,
    )
    expect(page.items[0]!.preview).toBe(part.text.slice(0, 256))
    reading.mockRestore()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    using held = spyOn(Storage, "readBinary").mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return readBinary(...args)
    })
    const snapshot = SessionHistoryDisplay.partContent(
      { sessionID: session.id, messageID: part.messageID, partID: part.id },
      session.scope.id,
    )
    await entered.promise
    try {
      await Session.updatePart({ ...part, text: "replacement" })
    } finally {
      release.resolve()
    }
    expect(await snapshot).toEqual({ part, version: page.items[0]!.content.version })
    expect((await PartContent.read(key)).part).toMatchObject({ text: "replacement" })
  }))

test("access-upgraded inline Part content has the same version as its cold summary", () =>
  inHome(async () => {
    const { session, part } = await streamFixture()
    const asset = await Asset.write(Buffer.from("retained attachment"), "text/plain", "report.txt")
    const attachment: MessageV2.AttachmentPart = {
      id: part.id,
      sessionID: session.id,
      messageID: part.messageID,
      type: "attachment",
      mime: "text/plain",
      filename: "report.txt",
      url: `asset://${asset}`,
    }
    await Session.updatePart(attachment)
    await Storage.removeTree(["sessions", session.scope.id, session.id, "display_parts_state"])
    const page = await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })
    const version = page.items[0]!.content.version
    const content = await SessionHistory.partContent({
      sessionID: session.id,
      messageID: part.messageID,
      partID: part.id,
      version,
    })
    expect(content.part).toMatchObject({ type: "attachment", presentation: { purpose: "deliverable" } })
    expect(content.version).toBe(MessageV2.summarizePart(content.part).content.version)
    expect(content.version).toBe(version)
    await Session.updatePart({ ...attachment, filename: "updated-report.txt" })
    const warmPage = await SessionHistory.partPage({ sessionID: session.id, messageID: part.messageID })
    const warm = await SessionHistory.partContent({
      sessionID: session.id,
      messageID: part.messageID,
      partID: part.id,
      version: warmPage.items[0]!.content.version,
    })
    expect(warm.part).toMatchObject({ filename: "updated-report.txt", presentation: { purpose: "deliverable" } })
    expect(warm.version).toBe(MessageV2.summarizePart(warm.part).content.version)
  }))

test("settled streaming deduplication evidence does not outlive its Part or enter global command receipts", () =>
  inHome(async () => {
    const { session, part } = await streamFixture()
    const receipts = async () =>
      (await Storage.snapshot(async (tx) => Array.fromAsync(tx.exportEntries()))).filter(
        (entry) => entry.type === "receipt",
      )
    const before = await receipts()
    for (const delta of ["one", "two", "three", "four"]) {
      part.text += delta
      await Session.updatePartDelta(part, delta)
      await Session.flushPartWrites(session.id)
    }
    const streamed = await receipts()
    await Session.updatePart(part)
    const replaced = await receipts()
    await Session.remove(session.id)
    const removed = await receipts()
    expect([streamed, replaced, removed]).toEqual([before, before, before])
  }))

test.each(["inline", "binary"])(
  "a committed %s append with a lost acknowledgement retries without duplication",
  (mode) =>
    inHome(async () => {
      const { session, part, key } = await streamFixture(mode === "inline" ? "prefix " : "prefix ".repeat(1024))
      await Session.updatePartDelta(part, part.text)
      await Session.flushPartWrites(session.id)
      part.text += "committed"
      const store = Storage.current().store
      const transaction = store.transaction.bind(store)
      const read = Storage.read
      let lost = false
      let receiptUnavailable = true
      using transactions = spyOn(store, "transaction").mockImplementation(
        async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
          const result = await transaction(body, options)
          if (!lost) {
            lost = true
            throw new StorageCommitUnknownError(undefined, new Error("lost acknowledgement"))
          }
          return result
        },
      )
      using receipts = spyOn(Storage, "read").mockImplementation(async <T>(source: string[]) => {
        if (lost && receiptUnavailable && source.join("/") === key.join("/"))
          throw new Error("receipt temporarily unavailable")
        return read<T>(source)
      })
      await Session.updatePartDelta(part, "committed")
      await expect(Session.flushPartWrites(session.id)).rejects.toThrow("receipt temporarily unavailable")
      const before = await Storage.versioned<PartContent.Stored>(key)
      receiptUnavailable = false
      await Session.flushPartWrites(session.id)
      expect(await Storage.versioned(key)).toEqual(before)
      expect(PartContent.checkpoint(before.value)?.chunks).toBe(mode === "inline" ? 0 : 2)
      part.text += " once"
      await Session.updatePartDelta(part, " once")
      await Session.flushPartWrites(session.id)
      expect((await PartContent.read(key)).part).toEqual(part)
      expect(PartContent.checkpoint(await Storage.read<PartContent.Stored>(key))?.chunks).toBe(
        mode === "inline" ? 0 : 3,
      )
    }),
)

test("transaction rollback never enrolls a Part for retry and cancelled publication cannot resurrect a deleted Part", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("abandoned".repeat(1024))
    await expect(
      Storage.transaction(async () => {
        await Session.updatePartDelta(part, part.text)
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    await Session.flushPartWrites(session.id)
    expect(await Storage.readMany([key])).toEqual([undefined])
    const buffer = new PartWriteBuffer(
      (path, batch, guard) => PartContent.append(path, batch, guard, async () => {}),
      10_000,
    )
    buffer.defer(part.id, key, part, part.text)
    await buffer.flushAll()
    const prepare = Storage.prepareBinary
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    using prepared = spyOn(Storage, "prepareBinary").mockImplementation(async (...args) => {
      const token = await prepare(...args)
      entered.resolve()
      await release.promise
      return token
    })
    part.text += " late"
    buffer.defer(part.id, key, part, " late")
    const pending = buffer.flushAll()
    await entered.promise
    await PartContent.remove(key)
    buffer.cancel(part.id)
    release.resolve()
    await expect(pending).rejects.toThrow()
    await buffer.flushAll()
    expect(await Storage.readMany([key])).toEqual([undefined])
    expect(
      (await Storage.snapshot(async (tx) => Array.fromAsync(tx.artifacts()))).filter((entry) =>
        entry.key.includes(part.id),
      ),
    ).toEqual([])
    expect(session.id).toBe(part.sessionID)
  }))

test("missing chunks and unknown streaming versions fail loudly instead of yielding empty text", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("retained".repeat(1024))
    await Session.updatePartDelta(part, part.text)
    await Session.flushPartWrites(session.id)
    const head = await Storage.read<PartContent.Stored>(key)
    await Storage.removeTree(StoragePath.partContent(key))
    await expect(PartContent.read(key)).rejects.toThrow("missing a committed chunk")
    if (!("textContent" in head)) throw new Error("Expected streaming head")
    await Storage.write(key, { ...head, textContent: { ...head.textContent, version: 2 } })
    await expect(MessageV2.parts({ sessionID: session.id, messageID: part.messageID })).rejects.toThrow("unsupported")
  }))

test("history search indexes committed streaming tails and removes superseded content after replacement", () =>
  inHome(async () => {
    const { session, part } = await streamFixture()
    for (const delta of ["padding ".repeat(8192) + "checkpoint ", "needle beyond the preview"]) {
      part.text += delta
      await Session.updatePartDelta(part, delta)
      await Session.flushPartWrites(session.id)
    }
    const prepare = async () => {
      let ready = false
      for (let index = 0; index < 32 && !ready; index++)
        ready = (await SessionHistorySearch.prepareBatch(session.scope.id, session.id)).ready
      expect(ready).toBe(true)
    }
    await prepare()
    expect((await SessionHistory.search({ sessionID: session.id, query: "checkpoint needle" })).items).toMatchObject([
      { messageID: part.messageID, partID: part.id },
    ])
    await Session.updatePart({ ...part, text: "replacement search result" })
    await prepare()
    expect((await SessionHistory.search({ sessionID: session.id, query: "checkpoint needle" })).items).toEqual([])
    expect((await SessionHistory.search({ sessionID: session.id, query: "replacement search" })).items).toMatchObject([
      { messageID: part.messageID, partID: part.id },
    ])
  }))

test("fork and transcript archive detach full Parts, while rollout pruning does not remove live Part content", () =>
  inHome(async () => {
    const { session, part, key } = await streamFixture("independent ")
    part.text += "content"
    await Session.updatePartDelta(part, "content")
    await Session.flushPartWrites(session.id)
    await Storage.removeTree(["sessions", session.scope.id, session.id, "rollout"])
    expect((await PartContent.read(key)).part).toEqual(part)
    const fork = await Session.fork({ sessionID: session.id })
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    const imported = await SessionImport.fromReport(report)
    await Session.remove(session.id)
    for (const sessionID of [fork.id, imported.rootSessionID]) {
      const messages = await Session.messages({ sessionID })
      expect(messages[0]!.parts[0]).toMatchObject({ type: "text", text: part.text })
      expect(messages[0]!.parts[0]).not.toHaveProperty("textContent")
    }
  }))

test("paused Session transfer copies streaming heads and binary tails independently of the removed source Home", async () => {
  await using sourceHome = await tmpdir()
  await using targetHome = await tmpdir()
  await using source = await testRuntime({ home: sourceHome.path })
  await using target = await testRuntime({ home: targetHome.path })
  const inSource = <T>(fn: () => Promise<T>) => source.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
  const inTarget = <T>(fn: () => Promise<T>) => target.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
  const fixture = await inSource(async () => {
    const fixture = await streamFixture("portable \ud83d")
    await Session.updatePartDelta(fixture.part, fixture.part.text)
    await Session.flushPartWrites(fixture.session.id)
    fixture.part.text += "\ude80 body\ud800"
    await Session.updatePartDelta(fixture.part, "\ude80 body\ud800")
    await Session.flushPartWrites(fixture.session.id)
    await SessionLifecycle.pause({ sessionID: fixture.session.id, reason: "interrupted" })
    return fixture
  })
  const host = await inTarget(() => SessionTransfer.host())
  await inSource(() =>
    SessionTransfer.prepare(fixture.session.id, { targetID: host.id, migrationID: crypto.randomUUID() }),
  )
  const blob = await inSource(() => SessionTransfer.archive(fixture.session.id))
  const receipt = await inTarget(() => SessionTransfer.stage(blob))
  const activation = await inSource(() => SessionTransfer.commit(fixture.session.id, receipt))
  const activated = await inTarget(() => SessionTransfer.activate(activation))
  await inSource(() => SessionTransfer.complete(fixture.session.id, activated))
  await source.close()
  await sourceHome[Symbol.asyncDispose]()
  await inTarget(async () => {
    expect((await PartContent.read(fixture.key)).part).toEqual(fixture.part)
    expect(await MessageV2.parts({ sessionID: fixture.session.id, messageID: fixture.part.messageID })).toEqual([
      fixture.part,
    ])
    expect(await Storage.queryKeys({ kind: "part", sessionID: fixture.session.id })).toEqual([fixture.key])
    await Session.removePart({
      sessionID: fixture.session.id,
      messageID: fixture.part.messageID,
      partID: fixture.part.id,
    })
    expect(await Storage.readMany([fixture.key])).toEqual([undefined])
  })
})

test.each(["committed", "before-head-commit"])(
  "a real process crash at %s reopens exactly its committed Part snapshot",
  async (boundary) => {
    await using home = await tmpdir()
    const Ready = z.object({ sessionID: z.string(), messageID: z.string(), partID: z.string(), boundary: z.string() })
    const ready = Promise.withResolvers<z.infer<typeof Ready>>()
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../support/streaming-part-crash.ts", import.meta.url)),
        home.path,
        boundary,
      ],
      {
        env: { ...process.env, SYNERGY_TEST_HOME: home.path, SYNERGY_HOME: undefined },
        stdout: "pipe",
        stderr: "pipe",
        ipc(message) {
          const value = Ready.safeParse(message)
          if (value.success) ready.resolve(value.data)
        },
        onExit(_child, code) {
          ready.reject(new Error(`Streaming fixture exited before the crash boundary: ${code}`))
        },
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const deadline = setTimeout(() => ready.reject(new Error("Streaming crash fixture did not become ready")), 10_000)
    try {
      const retained = await ready.promise
      expect(retained.boundary).toBe(boundary)
      child.kill("SIGKILL")
      await child.exited
      await using reopened = await testRuntime({ home: home.path })
      await reopened.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const parts = await MessageV2.parts({ sessionID: retained.sessionID, messageID: retained.messageID })
            expect(parts).toMatchObject([
              {
                id: retained.partID,
                type: "text",
                text: "committed prefix".repeat(1024) + (boundary === "committed" ? "🚀 committed tail" : "\ud83d"),
              },
            ])
            const page = await SessionHistoryDisplay.partPage(
              { sessionID: retained.sessionID, messageID: retained.messageID },
              "home",
            )
            expect(page.items[0]!.content.bytes).toBe(Buffer.byteLength(JSON.stringify(parts[0])))
          },
        }),
      )
    } catch (error) {
      if (child.exitCode === null) child.kill()
      await child.exited
      throw new AggregateError([error, await stderr, await stdout], "Streaming crash fixture failed")
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill()
      await child.exited
      await Promise.all([stdout, stderr])
    }
  },
  30_000,
)
