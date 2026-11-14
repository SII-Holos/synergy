import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Identifier } from "../../src/id/id"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { StoragePath } from "../../src/storage/path"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { prepareSessionMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { tmpdir } from "../support/fixture"
import { PartContent } from "../../src/session/part-content"
import type { MessageV2 } from "../../src/session/message-v2"

async function fixture(count: number) {
  const session = await Session.create({ workspace: null, environmentID: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    rootID: messageID,
    time: { created: 1 },
  })
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  const bytes = new Uint8Array([0, 255, 128, 1])
  const artifact = await RolloutArtifact.write(
    owner,
    (async function* () {
      yield bytes
    })(),
    "application/octet-stream",
  )
  const attachments = Array.from({ length: count }, (_, ordinal): MessageV2.AttachmentPart => ({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "attachment",
    filename: `evidence-${ordinal}.bin`,
    mime: "application/octet-stream",
    artifact,
    url: "asset://not-attachment-authority.bin",
  }))
  const part: MessageV2.ToolPart = {
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "tool",
    tool: "fixture",
    callID: "call-attachments",
    state: {
      status: "completed",
      input: {},
      output: "Created evidence",
      title: "Evidence",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments,
    },
  }
  await Session.updatePart(part)
  await prepareSessionMigrations(owner)
  const key = StoragePath.messagePart(
    Identifier.asScopeID(owner.scopeID),
    Identifier.asSessionID(session.id),
    Identifier.asMessageID(messageID),
    Identifier.asPartID(part.id),
  )
  return { session, part, bytes, target: { sessionID: session.id, messageID, partID: part.id }, key }
}

test("native tool attachment pages remain complete beyond one thousand files without opening the canonical Part body", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(1001)
        const versioned = StoreTransaction.prototype.versioned
        using noPartBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (JSON.stringify(key) === JSON.stringify(value.key))
            throw new Error("Attachment paging cannot decode a whole tool Part")
          return (versioned<T>).call(this, key)
        })
        const ordinals: number[] = []
        let cursor: string | undefined
        let version: string | undefined
        do {
          const page = await SessionHistory.attachmentPage({ ...value.target, cursor, limit: 32 })
          version ??= page.version
          expect(page.version).toBe(version)
          expect(page.items.length).toBeLessThanOrEqual(32)
          expect(page.total).toBe(1001)
          expect(JSON.stringify(page)).not.toMatch(/asset:|file:|nativepath|source/)
          ordinals.push(...page.items.map((item) => item.ordinal))
          cursor = page.cursor
        } while (cursor)
        expect(ordinals).toEqual(Array.from({ length: 1001 }, (_, index) => index))
        const bytes = await SessionHistory.attachmentContent({
          ...value.target,
          version: version!,
          ordinal: 1000,
          offset: 0,
          length: 2,
        })
        expect(bytes.state).toBe("ready")
        if (bytes.state !== "ready") throw new Error("Expected tool attachment evidence")
        expect(bytes.data).toEqual(value.bytes.subarray(0, 2))
        expect(bytes.descriptor.filename).toBe("evidence-1000.bin")
      },
    }),
  )
}, 15_000)

test("tool attachment reads refuse foreign producer artifacts and cancellation before another range", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(1)
        const foreign = await fixture(1)
        const page = await SessionHistory.attachmentPage(value.target)
        const state = foreign.part.state
        if (state.status !== "completed") throw new Error("Expected completed producer")
        const artifact = state.attachments![0].artifact!
        await Storage.write(
          [
            ...value.key.slice(0, 3),
            "attachment_index",
            value.key[4],
            value.key[6],
            "rows",
            String(0).padStart(16, "0"),
          ],
          {
            ordinal: 0,
            filename: "foreign.bin",
            mediaType: artifact.mediaType,
            artifact,
            hidden: false,
            purpose: "evidence",
          },
        )
        const denied = await SessionHistory.attachmentContent({
          ...value.target,
          version: page.version,
          ordinal: 0,
          length: 1,
        })

        expect(denied.state).toBe("unavailable")
        const controller = new AbortController()
        const reason = new Error("Cancel attachment range")
        controller.abort(reason)
        await expect(
          SessionHistory.attachmentContent({
            ...value.target,
            version: page.version,
            ordinal: 0,
            signal: controller.signal,
          }),
        ).rejects.toBe(reason)
      },
    }),
  )
}, 15_000)

test("attachment cursors and held byte reads reject another producer and a changed canonical tool version", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(4)
        const foreign = await fixture(1)
        const first = await SessionHistory.attachmentPage({ ...value.target, limit: 2 })
        expect(first.cursor).toBeDefined()
        await expect(SessionHistory.attachmentPage({ ...foreign.target, cursor: first.cursor })).rejects.toThrow(
          "another producer",
        )
        const state = value.part.state
        if (state.status !== "completed") throw new Error("Expected completed producer")
        await Session.updatePart({ ...value.part, state: { ...state, attachments: state.attachments!.toReversed() } })
        await expect(SessionHistory.attachmentPage({ ...value.target, cursor: first.cursor })).rejects.toThrow(
          "version",
        )
        await expect(
          SessionHistory.attachmentContent({ ...value.target, version: first.version, ordinal: 0 }),
        ).rejects.toThrow("changed")
        const current = await SessionHistory.attachmentPage(value.target)
        expect(current.items[0].filename).toBe("evidence-3.bin")
        const entered = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        const read = RolloutArtifact.readRange
        using held = spyOn(RolloutArtifact, "readRange").mockImplementation(async (...args) => {
          entered.resolve()
          await resume.promise
          return read(...args)
        })
        const pending = SessionHistory.attachmentContent({
          ...value.target,
          version: current.version,
          ordinal: 0,
          length: 2,
        })
        void pending.catch(() => {})
        await entered.promise
        try {
          await Session.updatePart({
            ...value.part,
            state: { ...state, attachments: state.attachments!.map((file) => ({ ...file, filename: "changed.bin" })) },
          })
          resume.resolve()
          await expect(pending).rejects.toThrow("changed")
        } finally {
          resume.resolve()
          await pending.catch(() => {})
        }
      },
    }),
  )
}, 15_000)

test("attachment index publication rolls back with its canonical producer and incomplete metadata is never a complete page", async () => {
  let fail = false
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("attachment-index-failure", async (_tx, keys) => {
        if (fail && keys.some((key) => key[3] === "attachment_index"))
          throw new Error("Fixture index publication failed")
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(3)
        const first = await SessionHistory.attachmentPage(value.target)
        const state = value.part.state
        if (state.status !== "completed") throw new Error("Expected completed producer")
        fail = true
        try {
          await expect(
            PartContent.replace(value.key, { ...value.part, state: { ...state, attachments: [] } }),
          ).rejects.toThrow("publication failed")
        } finally {
          fail = false
        }
        expect(await SessionHistory.attachmentPage(value.target)).toEqual(first)
        const root = [...value.key.slice(0, 3), "attachment_index", value.key[4], value.key[6]]
        await Storage.remove([...root, "rows", String(1).padStart(16, "0")])
        await expect(SessionHistory.attachmentPage(value.target)).rejects.toThrow("incomplete")
      },
    }),
  )
}, 15_000)

test("central owning migration prepares a historical tool once and restart paging reads no canonical body", async () => {
  await using directory = await tmpdir()
  let target: { sessionID: string; messageID: string; partID: string }
  let key: string[]
  let original: unknown
  let displayKey: string[]
  let stateKey: string[]
  let dirtyKey: string[]
  let originalDisplay: unknown
  let originalState: unknown
  {
    await using runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const value = await fixture(41)
          target = value.target
          key = value.key
          original = await Storage.read(key)
          displayKey = StoragePath.sessionDisplayPart("home", value.session.id, value.target.messageID, value.part.id)
          stateKey = StoragePath.sessionDisplayPartsState("home", value.session.id, value.target.messageID)
          dirtyKey = StoragePath.sessionTextDirty("home", value.session.id, value.target.messageID, value.part.id)
          originalDisplay = {
            ...(await Storage.read<Record<string, unknown>>(displayKey)),
            future: { keep: true },
          }
          originalState = { ...(await Storage.read<Record<string, unknown>>(stateKey)), future: { keep: true } }
          await Storage.write(displayKey, originalDisplay)
          await Storage.write(stateKey, originalState)
          await Storage.remove(dirtyKey)
          await Storage.removeTree([...key.slice(0, 3), "attachment_index", key[4], key[6]])
          await Storage.remove([
            "sessions",
            "home",
            value.session.id,
            "migrations",
            "session",
            "20261112-session-attachment-metadata-pages",
          ])
        },
      }),
    )
  }
  {
    await using runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const first = await SessionHistory.attachmentPage({ ...target!, limit: 32 })
          expect(first.total).toBe(41)
          expect(first.items).toHaveLength(32)
          expect(await Storage.read(key!)).toEqual(original)
          expect(await Storage.read(displayKey!)).toEqual(originalDisplay)
          expect(await Storage.read(stateKey!)).toEqual(originalState)
          expect(await Storage.read(dirtyKey!)).toEqual({ key })
          const versioned = StoreTransaction.prototype.versioned
          using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            current: string[],
          ) {
            if (JSON.stringify(current) === JSON.stringify(key))
              throw new Error("Steady attachment pages cannot reopen the historical Part")
            return (versioned<T>).call(this, current)
          })
          const second = await SessionHistory.attachmentPage({ ...target!, cursor: first.cursor })
          expect(second.items).toHaveLength(9)
          expect(second.cursor).toBeUndefined()
        },
      }),
    )
  }
}, 15_000)

test("owning presentation upgrade filters hidden files without losing an empty page continuation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(3)
        const state = value.part.state
        if (state.status !== "completed") throw new Error("Expected completed producer")
        const files = state.attachments!.map((file, index) => ({
          ...file,
          presentation: { purpose: "evidence" as const, hidden: index !== 1 },
        }))
        await Session.updatePart({ ...value.part, state: { ...state, attachments: files } })
        const canonical = await Storage.read(value.key)
        const displayKey = StoragePath.sessionDisplayPart(
          "home",
          value.session.id,
          value.target.messageID,
          value.part.id,
        )
        const stateKey = StoragePath.sessionDisplayPartsState("home", value.session.id, value.target.messageID)
        const originalDisplay = await Storage.read<MessageV2.PartSummary>(displayKey)
        const originalState = await Storage.read<{ generation: number }>(stateKey)
        await Storage.write(displayKey, {
          ...originalDisplay,
          attachments: { evidence: 3, deliverable: 0 },
          future: { keep: true },
        })
        await Storage.write(stateKey, { ...originalState, future: { keep: true } })
        const root = [...value.key.slice(0, 3), "attachment_index", value.key[4], value.key[6]]
        const header = await Storage.read<{ revision: string }>([...root, "header"])
        await Storage.write([...root, "header"], { version: 1, revision: header.revision, kind: "tool", count: 3 })
        for (let ordinal = 0; ordinal < 3; ordinal++)
          await Storage.write([...root, "rows", String(ordinal).padStart(16, "0")], {
            ordinal,
            filename: "old-derived.bin",
            mediaType: "application/octet-stream",
          })
        await Storage.remove([
          "sessions",
          "home",
          value.session.id,
          "migrations",
          "session",
          "20261112-session-attachment-presentation-pages-v2",
        ])
        const first = await SessionHistory.attachmentPage({ ...value.target, limit: 1 })
        expect(first.total).toBe(1)
        expect(await Storage.read(displayKey)).toEqual({ ...originalDisplay, future: { keep: true } })
        expect(await Storage.read(stateKey)).toEqual({
          ...originalState,
          generation: originalState.generation + 1,
          future: { keep: true },
        })
        expect(first.items).toEqual([])
        expect(first.cursor).toBeDefined()
        const retained = await SessionHistory.attachmentContent({
          ...value.target,
          version: first.version,
          ordinal: 0,
          length: 1,
        })
        expect(retained.state).toBe("ready")
        const display = await SessionHistory.partPage({
          sessionID: value.session.id,
          messageID: value.target.messageID,
          limit: 64,
        })
        expect(display.items.find((part) => part.id === value.part.id)?.attachments).toMatchObject({
          evidence: 1,
          deliverable: 0,
        })
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (JSON.stringify(key) === JSON.stringify(value.key))
            throw new Error("Prepared presentation pages cannot reopen canonical Part")
          return (versioned<T>).call(this, key)
        })
        const second = await SessionHistory.attachmentPage({ ...value.target, cursor: first.cursor, limit: 1 })
        expect(second.items.map((file) => file.filename)).toEqual(["evidence-1.bin"])
        expect(second.cursor).toBeDefined()
        const third = await SessionHistory.attachmentPage({ ...value.target, cursor: second.cursor, limit: 1 })
        expect(third.items).toEqual([])
        expect(third.cursor).toBeUndefined()
        noBody.mockRestore()
        expect(await Storage.read(value.key)).toEqual(canonical)
        const prepared = await Storage.readMany([displayKey, stateKey])
        await SessionHistory.attachmentPage({ ...value.target, limit: 1 })
        expect(await Storage.readMany([displayKey, stateKey])).toEqual(prepared)
      },
    }),
  )
}, 15000)

test("fresh attachment projections skip canonical body migration and unknown index versions fail closed", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await fixture(2)
        const textID = Identifier.ascending("part")
        await Session.updatePart({
          id: textID,
          sessionID: value.session.id,
          messageID: value.target.messageID,
          type: "text",
          text: "Fresh text",
        })
        const receipt = ["sessions", "home", value.session.id, "migrations", "session"]
        await Storage.remove([...receipt, "20261112-session-attachment-metadata-pages"])
        await Storage.remove([...receipt, "20261112-session-attachment-presentation-pages-v2"])
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (key.length === 7 && key[3] === "messages" && key[5] === "parts" && key[2] === value.session.id)
            throw new Error("Fresh projections cannot reopen canonical bodies")
          return (versioned<T>).call(this, key)
        })
        await prepareSessionMigrations({ scopeID: "home", sessionID: value.session.id })
        expect((await SessionHistory.attachmentPage(value.target)).total).toBe(2)
        const root = [...value.key.slice(0, 3), "attachment_index", value.key[4], value.key[6]]
        const current = await Storage.read<Record<string, unknown>>([...root, "header"])
        const future = { ...current, version: 99 }
        await Storage.write([...root, "header"], future)
        await Storage.remove([...receipt, "20261112-session-attachment-presentation-pages-v2"])
        await expect(SessionHistory.attachmentPage(value.target)).rejects.toThrow("unsupported")
        expect(await Storage.read([...root, "header"])).toEqual(future)
      },
    }),
  )
}, 15000)
