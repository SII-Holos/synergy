import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Identifier } from "../../src/id/id"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import type { MessageV2 } from "../../src/session/message-v2"
import { prepareSessionMigrations } from "../../src/migration"
import { tmpdir } from "../support/fixture"
import { PartContent } from "../../src/session/part-content"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { SessionPartFieldSource } from "../../src/session/part-field-source"

async function producer() {
  const session = await Session.create({ workspace: null, environmentID: null })
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    rootID,
    isRoot: true,
    time: { created: 1 },
  })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    rootID,
    parentID: rootID,
    agent: "general",
    mode: "general",
    providerID: "fixture",
    modelID: "fixture",
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2, completed: 3 },
  })
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  const input = { query: "原始 input🌏".repeat(50_000) }
  const output = "原始 output🌏".repeat(100_000)
  await RolloutLedger.beginRun(owner, rootID)
  const recorded = await RolloutLedger.beginTool({
    owner,
    runID: rootID,
    messageID,
    toolCallID: "bounded-header-call",
    tool: "fixture",
    args: input,
  })
  const artifact = await RolloutArtifact.writeText(owner, "attachment evidence")
  const outputArtifact = await RolloutArtifact.writeText(owner, output)
  const part = {
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "tool" as const,
    callID: "bounded-header-call",
    tool: "fixture",
    futureProducerField: { keep: "immutable unknown producer" },
    state: {
      status: "completed" as const,
      input,
      output: "bounded preview",
      outputArtifact,
      outputBytes: Buffer.byteLength(output),
      outputTruncated: true,
      title: "Bounded tool header",
      metadata: { unboundedBody: "metadata".repeat(150_000), future: { nested: ["retained canonical value"] } },
      time: { start: 2, end: 3 },
      attachments: Array.from({ length: 1001 }, (_, ordinal): MessageV2.AttachmentPart => ({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "attachment",
        filename: `file-${ordinal}.txt`,
        mime: "text/plain",
        url: "asset://not-global-read-authority.txt",
        artifact,
      })),
    },
  }
  await Session.updatePart(part)
  const key = StoragePath.messagePart(
    Identifier.asScopeID(session.scope.id),
    Identifier.asSessionID(session.id),
    Identifier.asMessageID(messageID),
    Identifier.asPartID(part.id),
  )
  const canonical = await Storage.read<MessageV2.ToolPart>(key)
  const retained = { ...canonical, futureProducerField: part.futureProducerField }
  await PartContent.replace(key, retained)
  return {
    key,
    target: { sessionID: session.id, messageID, partID: part.id },
    input,
    output,
    recorded,
    original: await Storage.read(key),
  }
}

test("an eager tool descriptor never decodes the producer's complete input, metadata or attachment collection", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await producer()
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (JSON.stringify(key) === JSON.stringify(value.key))
            throw new Error("Tool descriptors cannot decode their canonical Part body")
          return (versioned<T>).call(this, key)
        })
        const descriptor = await SessionHistory.preparePartFields(value.target)
        expect(descriptor.version).toBeTruthy()
        if (descriptor.state === "ready") {
          expect(Buffer.byteLength(JSON.stringify(descriptor.header))).toBeLessThanOrEqual(64 * 1024)
          expect(descriptor.header).not.toHaveProperty("state.attachments")
          expect(descriptor.header).not.toHaveProperty("state.input")
          expect(descriptor.header).not.toHaveProperty("state.output")
          expect(descriptor.header).not.toHaveProperty("state.metadata.unboundedBody")
        }
      },
    }),
  )
}, 15_000)

test("prepared tool field windows seek exact original bytes without rereading the canonical Part body", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await producer()
        const descriptor = await SessionHistory.partFieldDescriptor(value.target)
        expect(descriptor.fields.find((field) => field.field === "input")).toMatchObject({
          bytes: value.recorded.input.bytes,
          sha256: value.recorded.input.sha256,
        })
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (JSON.stringify(key) === JSON.stringify(value.key))
            throw new Error("Tool field ranges cannot decode their canonical Part body")
          return (versioned<T>).call(this, key)
        })
        for (const [field, original] of [
          ["input", JSON.stringify(value.input)],
          ["output", value.output],
        ] as const) {
          const bytes = Buffer.from(original)
          const range = await SessionHistory.partField({
            ...value.target,
            version: descriptor.version,
            field,
            offset: 13,
            length: 131_072,
          })
          expect(range.data).toEqual(bytes.subarray(13, 13 + 131_072))
          expect(range.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        }
        noBody.mockRestore()
        expect(await Storage.read(value.key)).toEqual(value.original)
      },
    }),
  )
}, 15_000)

test("the central Session upgrade restores missing native field sources once without rewriting unknown producer data", async () => {
  await using directory = await tmpdir()
  let retained: Awaited<ReturnType<typeof producer>>
  {
    await using runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          retained = await producer()
          const value = retained
          await prepareSessionMigrations({ scopeID: value.key[1]!, sessionID: value.target.sessionID })
          await Storage.removeTree([...value.key.slice(0, 3), "part_field_sources", value.key[4], value.key[6]])
          await expect(SessionHistory.preparePartFields(value.target)).rejects.toBeInstanceOf(Storage.NotFoundError)
          await Storage.remove([
            "sessions",
            value.key[1]!,
            value.target.sessionID,
            "migrations",
            "session",
            "20261112-session-native-field-sources",
          ])
        },
      }),
    )
  }
  for (const phase of ["upgrade", "restart"] as const) {
    await using runtime = await testRuntime({ home: directory.path })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const value = retained!
          const versioned = StoreTransaction.prototype.versioned
          using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            key: string[],
          ) {
            if (phase === "restart" && JSON.stringify(key) === JSON.stringify(value.key))
              throw new Error("A completed owning upgrade cannot reopen the canonical body")
            return (versioned<T>).call(this, key)
          })
          await prepareSessionMigrations({ scopeID: value.key[1]!, sessionID: value.target.sessionID })
          const descriptor = await SessionHistory.partFieldDescriptor(value.target)
          expect(descriptor.header.type).toBe("tool")
          noBody.mockRestore()
          expect(await Storage.read(value.key)).toEqual(value.original)
          const original = await SessionHistory.partContent(value.target)
          expect(Reflect.get(original.part, "futureProducerField")).toEqual({ keep: "immutable unknown producer" })
          if (original.part.type !== "tool" || original.part.state.status !== "completed")
            throw new Error("Expected the original completed tool")
          expect(original.part.state.metadata.unboundedBody === "metadata".repeat(150_000)).toBe(true)
          expect(original.part.state.metadata.future).toEqual({ nested: ["retained canonical value"] })
        },
      }),
    )
  }
}, 15_000)

test("native field rows preserve canonical JSON normalization and seek UTF8 fields across their fixed byte boundaries", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
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
        const input = {
          omitted: undefined,
          values: [undefined, NaN, new Date("2026-01-02T03:04:05.000Z")],
          text: "utf8🌏".repeat(9000),
        }
        const error = "native error🌏".repeat(20_000)
        const part: MessageV2.ToolPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: "json-fields",
          tool: "fixture",
          state: { status: "error", input, error, time: { start: 1, end: 2 } },
        }
        await Session.updatePart(part)
        const target = { sessionID: session.id, messageID, partID: part.id }
        const descriptor = await SessionHistory.partFieldDescriptor(target)
        for (const [field, value] of [
          ["input", JSON.stringify(input)],
          ["error", error],
        ] as const) {
          const bytes = Buffer.from(value)
          const range = await SessionHistory.partField({
            ...target,
            field,
            version: descriptor.version,
            offset: 16_382,
            length: 65_536,
          })
          expect(range.data).toEqual(bytes.subarray(16_382, 16_382 + 65_536))
          expect(range.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        }
      },
    }),
  )
}, 15_000)

test.each(["boxed", "omitted", "stateful"] as const)(
  "native field sources retain the actual persisted JSON value for %s producer values",
  async (kind) => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
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
          let calls = 0
          const input =
            kind === "boxed"
              ? { values: [new Number(7), new String("native value"), new Boolean(false)] }
              : kind === "omitted"
                ? { omitted: { toJSON: () => undefined }, values: [{ toJSON: () => undefined }] }
                : { changing: { toJSON: () => ({ selected: ++calls }) } }
          const part: MessageV2.ToolPart = {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: "canonical-json",
            tool: "fixture",
            state: { status: "running", input, time: { start: 1 } },
          }
          const key = StoragePath.messagePart(
            Identifier.asScopeID(session.scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID(messageID),
            Identifier.asPartID(part.id),
          )
          await PartContent.replace(key, part)
          const persisted = await Storage.read<MessageV2.ToolPart>(key)
          const expected = JSON.stringify(persisted.state.input)
          expect(calls).toBe(kind === "stateful" ? 1 : 0)
          const versioned = StoreTransaction.prototype.versioned
          using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            current: string[],
          ) {
            if (JSON.stringify(current) === JSON.stringify(key))
              throw new Error("Ordinary field reads cannot repeat producer normalization")
            return (versioned<T>).call(this, current)
          })
          const target = { sessionID: session.id, messageID, partID: part.id }
          const descriptor = await SessionHistory.partFieldDescriptor(target)
          const range = await SessionHistory.partField({
            ...target,
            version: descriptor.version,
            field: "input",
            offset: 0,
            length: 131_072,
          })
          expect(new TextDecoder().decode(range.data)).toBe(expected)
          expect(range.sha256).toBe(createHash("sha256").update(expected).digest("hex"))
          expect(calls).toBe(kind === "stateful" ? 1 : 0)
        },
      }),
    )
  },
)

test("a failed field-source publication rolls its canonical producer and native version back together", async () => {
  let fail = false
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("field-source-fault", async (_tx, keys) => {
        if (fail && keys.some((key) => key[3] === "part_field_sources"))
          throw new Error("Native field source publication failed")
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await producer()
        const before = await SessionHistory.partFieldDescriptor(value.target)
        const original = await Storage.read<MessageV2.ToolPart>(value.key)
        fail = true
        try {
          await expect(
            PartContent.replace(value.key, {
              ...original,
              state: {
                status: "error",
                input: { different: true },
                error: "must roll back",
                time: { start: 1, end: 2 },
              },
            }),
          ).rejects.toThrow("publication failed")
        } finally {
          fail = false
        }
        const after = await SessionHistory.partFieldDescriptor(value.target)
        expect(after).toEqual(before)
        expect(await Storage.read(value.key)).toEqual(value.original)
      },
    }),
  )
}, 15_000)

test("fresh field projections skip canonical bodies during upgrade while unknown projection versions fail without rewriting", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await producer()
        const sourceKey = [...value.key.slice(0, 3), "part_field_sources", value.key[4], value.key[6], "header"]
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          key: string[],
        ) {
          if (JSON.stringify(key) === JSON.stringify(value.key))
            throw new Error("Fresh field projections cannot be rescanned")
          return (versioned<T>).call(this, key)
        })
        const owner = { scopeID: value.key[1]!, sessionID: value.target.sessionID }
        await SessionPartFieldSource.migration.upSession!(owner, () => {})
        const current = await Storage.read<Record<string, unknown>>(sourceKey)
        const future = { ...current, version: 99 }
        await Storage.write(sourceKey, future)
        await expect(SessionPartFieldSource.migration.upSession!(owner, () => {})).rejects.toThrow("unsupported")
        expect(await Storage.read(sourceKey)).toEqual(future)
      },
    }),
  )
}, 15_000)

test("later native tool admission selects the original model envelope without rewriting or reopening its running Part", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          rootID,
          time: { created: 1 },
        })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          rootID,
          parentID: rootID,
          agent: "general",
          mode: "general",
          providerID: "fixture",
          modelID: "fixture",
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        })
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        await RolloutLedger.beginRun(owner, rootID)
        const id = Identifier.ascending("part")
        await Session.updatePart({
          id,
          sessionID: session.id,
          messageID,
          type: "tool",
          tool: "fixture",
          callID: "late-input",
          state: { status: "running", input: { normalized: "execution args" }, time: { start: 2 } },
        })
        const target = { sessionID: session.id, messageID, partID: id }
        const before = await SessionHistory.partFieldDescriptor(target)
        const key = StoragePath.messagePart(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          Identifier.asMessageID(messageID),
          Identifier.asPartID(id),
        )
        const revision = (await Storage.revisions([key]))[0]
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const range = SessionPartFieldSource.range
        using heldRange = spyOn(SessionPartFieldSource, "range").mockImplementation(async (...args) => {
          const bytes = await range(...args)
          entered.resolve()
          await release.promise
          return bytes
        })
        const held = SessionHistory.partField({
          ...target,
          version: before.version,
          field: "input",
          offset: 0,
          length: 128,
        })
        const stale = held.catch((error) => error)
        await Promise.race([
          entered.promise,
          held.then(
            () => {
              throw new Error("Expected to hold the admitted original-input range")
            },
            (error) => {
              throw error
            },
          ),
        ])
        const args = { work_brief: "Original model intent", input: { normalized: "execution args" } }
        const recorded = await (async () => {
          try {
            return await RolloutLedger.beginTool({
              owner,
              runID: rootID,
              messageID,
              toolCallID: "late-input",
              tool: "fixture",
              args,
            })
          } finally {
            release.resolve()
          }
        })()
        expect(await stale).toMatchObject({ message: expect.stringContaining("changed") })
        await RolloutLedger.writeTool({
          ...recorded,
          status: "failed",
          ended: Date.now(),
          error: "large native execution error".repeat(50_000),
        })
        expect((await Storage.revisions([key]))[0]).toBe(revision)
        const versioned = StoreTransaction.prototype.versioned
        using noBody = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
          this: StoreTransaction,
          current: string[],
        ) {
          if (
            JSON.stringify(current) === JSON.stringify(key) ||
            (current.at(-2) === "tools" && current.at(-1) === recorded.id)
          )
            throw new Error("Late tool evidence cannot open its running Part or complete execution record")
          return (versioned<T>).call(this, current)
        })
        const after = await SessionHistory.partFieldDescriptor(target)
        expect(after.version).not.toBe(before.version)
        if (!recorded.input.sha256) throw new Error("Expected the complete original input digest")
        expect(after.fields.find((field) => field.field === "input")?.sha256).toBe(recorded.input.sha256)
        const input = await SessionHistory.partField({
          ...target,
          version: after.version,
          field: "input",
          offset: 0,
          length: 131_072,
        })
        expect(new TextDecoder().decode(input.data)).toBe(JSON.stringify(args))
        await expect(
          SessionHistory.partField({ ...target, version: before.version, field: "input", offset: 0, length: 1 }),
        ).rejects.toThrow("changed")
      },
    }),
  )
}, 15_000)
