import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { PartContent } from "../../src/session/part-content"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { StoredToolOutput } from "../../src/tool/stored-output"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"
import { SessionPartFieldCache } from "../../src/session/part-field-cache"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function message() {
  const session = await Session.create({ workspace: null, environmentID: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    isRoot: true,
    rootID: messageID,
    time: { created: 1 },
  })
  return { sessionID: session.id, messageID }
}

test("native text fields return bounded UTF8 bytes across split surrogates without full Part hydration", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const identity = await message()
        const part: MessageV2.TextPart = { ...identity, id: Identifier.ascending("part"), type: "text", text: "" }
        for (const delta of ["a".repeat(3 * 1024 * 1024) + "\ud83c", "\udf0d漢字\n".repeat(100000)]) {
          part.text += delta
          await Session.updatePartDelta(part, delta)
          await Session.flushPartWrites(identity.sessionID)
        }
        using noHydrate = spyOn(PartContent, "hydrate").mockImplementation(() => {
          throw new Error("Full Part hydration is forbidden")
        })
        const descriptor = await SessionHistory.partFieldDescriptor({ ...identity, partID: part.id })
        expect(descriptor.header).toMatchObject({ id: part.id, type: "text" })
        expect("text" in descriptor.header || "textContent" in descriptor.header).toBe(false)
        const bytes = Buffer.from(part.text)
        expect(descriptor.fields).toEqual([
          {
            field: "text",
            bytes: bytes.length,
            sha256: sha(bytes),
            mediaType: "text/plain;charset=utf-8",
            original: "complete",
          },
        ])
        const offset = 3 * 1024 * 1024 + 1
        const result = await (async () => {
          using noPrefixRescan = spyOn(PartContent, "textBlocks").mockImplementation(() => {
            throw new Error("A published field range must seek directly without replaying its prefix")
          })
          return await SessionHistory.partField({
            ...identity,
            partID: part.id,
            field: "text",
            version: descriptor.version,
            offset,
            length: 128 * 1024,
          })
        })()
        expect(result.data).toEqual(bytes.subarray(offset, offset + 128 * 1024))
        expect(result.nextOffset).toBe(offset + result.data.length)
        expect(result.totalBytes).toBe(bytes.length)
        expect(result.sha256).toBe(sha(bytes))
        expect(result.complete).toBe(false)
        part.text += "later"
        await Session.updatePartDelta(part, "later")
        await Session.flushPartWrites(identity.sessionID)
        await expect(
          SessionHistory.partField({
            ...identity,
            partID: part.id,
            field: "text",
            version: descriptor.version,
            offset: 0,
            length: 1024,
          }),
        ).rejects.toThrow("changed")
      },
    }),
  )
}, 15000)

test("tool input and complete output reuse native Rollout artifacts rather than a truncated preview", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await message()
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: root.sessionID,
          role: "assistant",
          rootID: root.messageID,
          parentID: root.messageID,
          agent: "general",
          mode: "general",
          modelID: "fixture",
          providerID: "fixture",
          path: { cwd: "/evidence", root: "/evidence" },
          time: { created: 1, completed: 2 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const owner = { kind: "session" as const, scopeID: "home", sessionID: root.sessionID }
        const input = { query: "精确🌏".repeat(100000) }
        await RolloutLedger.beginRun(owner, root.messageID)
        const recorded = await RolloutLedger.beginTool({
          owner,
          runID: root.messageID,
          messageID,
          toolCallID: "field-call",
          tool: "fixture",
          args: input,
        })
        const original = "完整输出🌏".repeat(250000)
        const outputArtifact = await RolloutArtifact.writeText(owner, original)
        const completed: MessageV2.ToolStateCompleted = {
          status: "completed",
          input,
          output: "preview only",
          outputBytes: Buffer.byteLength(original),
          outputTruncated: true,
          outputArtifact,
          title: "Fixture",
          metadata: { outputPath: "/never/follow/an/arbitrary/path" },
          time: { start: 1, end: 2 },
        }
        const part: MessageV2.ToolPart = {
          id: Identifier.ascending("part"),
          sessionID: root.sessionID,
          messageID,
          type: "tool",
          callID: "field-call",
          tool: "fixture",
          state: completed,
        }
        await Session.updatePart(part)
        using noHydrate = spyOn(PartContent, "hydrate").mockImplementation(() => {
          throw new Error("Full Part hydration is forbidden")
        })
        using noWholeInventory = spyOn(RolloutLedger, "tools").mockImplementation(() => {
          throw new Error("Whole tool inventory is forbidden")
        })
        const identity = { sessionID: root.sessionID, messageID, partID: part.id }
        const descriptor = await SessionHistory.partFieldDescriptor(identity)
        expect(descriptor.header).toMatchObject({
          type: "tool",
          callID: "field-call",
          state: { status: "completed", title: "Fixture", time: { start: 1, end: 2 } },
        })
        expect(
          descriptor.header.type === "tool" &&
            ("input" in descriptor.header.state || "output" in descriptor.header.state),
        ).toBe(false)
        expect(descriptor.fields.find((field) => field.field === "input")).toMatchObject({
          bytes: recorded.input.bytes,
          sha256: recorded.input.sha256,
          mediaType: "application/json",
          original: "complete",
        })
        expect(descriptor.fields.find((field) => field.field === "output")).toMatchObject({
          bytes: outputArtifact.bytes,
          sha256: outputArtifact.sha256,
          original: "complete",
        })
        for (const [field, expected] of [
          ["input", Buffer.from(JSON.stringify(input))],
          ["output", Buffer.from(original)],
        ] as const) {
          const result = await SessionHistory.partField({
            ...identity,
            field,
            version: descriptor.version,
            offset: 123,
            length: 128 * 1024,
          })
          expect(result.data).toEqual(expected.subarray(123, 123 + 128 * 1024))
          expect(result.data.length).toBeLessThanOrEqual(128 * 1024)
        }
        const reference = await StoredToolOutput.save("tool_field_retained", original)
        await Session.updatePart({
          ...part,
          state: { ...completed, outputArtifact: undefined, metadata: { outputPath: reference } },
        })
        const retained = await SessionHistory.partFieldDescriptor(identity)
        expect(retained.fields.find((field) => field.field === "output")).toMatchObject({
          bytes: Buffer.byteLength(original),
          sha256: sha(Buffer.from(original)),
          original: "complete",
        })
        const saved = await SessionHistory.partField({
          ...identity,
          field: "output",
          version: retained.version,
          offset: 1024,
          length: 65536,
        })
        expect(saved.data).toEqual(Buffer.from(original).subarray(1024, 1024 + 65536))
      },
    }),
  )
}, 15000)

test("inline tool raw JSON and errors retain exact field bytes and missing originals stay partial", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const identity = await message()
        const id = Identifier.ascending("part")
        const raw = '{"pending":"🌏\\n"'
        await Session.updatePart({
          ...identity,
          id,
          type: "tool",
          callID: "inline-call",
          tool: "fixture",
          state: { status: "generating", input: {}, raw, charsReceived: raw.length },
        })
        let descriptor = await SessionHistory.partFieldDescriptor({ ...identity, partID: id })
        const pending = await SessionHistory.partField({
          ...identity,
          partID: id,
          field: "input",
          version: descriptor.version,
          offset: 0,
          length: 128 * 1024,
        })
        expect(pending.data).toEqual(Buffer.from(raw))
        expect(pending.original).toBe("partial")
        const input = { 'surrogate🌏"key': [null, true, 2, "a\n🌏\ud800".repeat(40000)], nested: { value: "keep" } }
        const error = "execution failed 漢字\n".repeat(10000)
        await Session.updatePart({
          ...identity,
          id,
          type: "tool",
          callID: "inline-call",
          tool: "fixture",
          state: { status: "error", input, error, time: { start: 1, end: 2 } },
        })
        descriptor = await SessionHistory.partFieldDescriptor({ ...identity, partID: id })
        for (const [field, bytes] of [
          ["input", Buffer.from(JSON.stringify(input))],
          ["error", Buffer.from(error)],
        ] as const) {
          expect(descriptor.fields.find((item) => item.field === field)?.sha256).toBe(sha(bytes))
          const content = await SessionHistory.partField({
            ...identity,
            partID: id,
            field,
            version: descriptor.version,
            offset: 1,
            length: 128 * 1024,
          })
          expect(content.data).toEqual(bytes.subarray(1, 1 + 128 * 1024))
        }
        await Session.updatePart({
          ...identity,
          id,
          type: "tool",
          callID: "inline-call",
          tool: "fixture",
          state: {
            status: "completed",
            input: {},
            output: "retained preview",
            outputTruncated: true,
            outputBytes: 1000000,
            title: "Missing original",
            metadata: { outputPath: "/arbitrary/private/file" },
            time: { start: 1, end: 2 },
          },
        })
        descriptor = await SessionHistory.partFieldDescriptor({ ...identity, partID: id })
        expect(descriptor.fields.find((item) => item.field === "output")).toMatchObject({
          bytes: Buffer.byteLength("retained preview"),
          original: "partial",
        })
        await expect(
          SessionHistory.partField({
            ...identity,
            partID: id,
            field: "output",
            version: descriptor.version,
            offset: 999,
            length: 1,
          }),
        ).rejects.toThrow("out of range")
        await expect(
          SessionHistory.partField({
            ...identity,
            partID: id,
            field: "output",
            version: descriptor.version,
            offset: 0,
            length: 128 * 1024 + 1,
          }),
        ).rejects.toThrow()
      },
    }),
  )
}, 15000)

test("field preparation outlives a cancelled RPC waiter and reports real progress before ready", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const identity = await message()
        const part: MessageV2.ReasoningPart = {
          ...identity,
          id: Identifier.ascending("part"),
          type: "reasoning",
          text: "reasoning🌏".repeat(100000),
          time: { start: 3, end: 4 },
        }
        await Session.updatePartDelta(part, part.text)
        await Session.flushPartWrites(identity.sessionID)
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let started!: () => void
        const entered = new Promise<void>((resolve) => {
          started = resolve
        })
        const original = PartContent.textBlocks
        let scans = 0
        using delay = spyOn(PartContent, "textBlocks").mockImplementation((...args) =>
          (async function* () {
            scans++
            started()
            await gate
            yield* original(...args)
          })(),
        )
        const input = { ...identity, partID: part.id }
        const first = await SessionHistory.preparePartFields(input)
        expect(first.state).toBe("preparing")
        await entered
        const controller = new AbortController()
        const waiter = SessionHistory.partFieldDescriptor({ ...input, signal: controller.signal })
        controller.abort(new Error("private read caller left"))
        await expect(waiter).rejects.toThrow("private read caller left")
        const pending = await SessionHistory.preparePartFields(input)
        expect(pending).toMatchObject({ state: "preparing", version: first.version, completedBytes: 0 })
        release()
        const ready = await SessionHistory.partFieldDescriptor(input)
        expect(ready.version).toBe(first.version)
        expect(ready.header).toMatchObject({ type: "reasoning", time: { start: 3, end: 4 } })
        expect(ready.fields[0]).toMatchObject({
          field: "text",
          bytes: Buffer.byteLength(part.text),
          sha256: sha(Buffer.from(part.text)),
        })
        expect(scans).toBe(1)
      },
    }),
  )
}, 15000)

test("compaction recovery keeps a bodyless header and serves its full summary through native text ranges", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const identity = await message()
        const id = Identifier.ascending("part")
        const summary = "保留完整恢复摘要🌏\n".repeat(100000)
        await Session.updatePart({
          ...identity,
          id,
          type: "compaction_recovery",
          summary,
          mechanical: true,
          validated: true,
        })
        await Session.flushPartWrites(identity.sessionID)
        const descriptor = await SessionHistory.partFieldDescriptor({ ...identity, partID: id })
        expect(descriptor.header).toMatchObject({ type: "compaction_recovery", mechanical: true, validated: true })
        expect("summary" in descriptor.header).toBe(false)
        expect(descriptor.fields[0]).toMatchObject({
          field: "text",
          bytes: Buffer.byteLength(summary),
          sha256: sha(Buffer.from(summary)),
        })
        const result = await SessionHistory.partField({
          ...identity,
          partID: id,
          field: "text",
          version: descriptor.version,
          offset: 2_000_000,
          length: 128 * 1024,
        })
        expect(result.data).toEqual(Buffer.from(summary).subarray(2_000_000, 2_000_000 + 128 * 1024))
      },
    }),
  )
}, 15000)

test("Runtime close cancels and drains preparation before Storage closes without publishing an incomplete generation", async () => {
  await using home = await tmpdir()
  const runtime = await testRuntime({ home: home.path })
  let stopped = false
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = PartContent.textBlocks
  using stalled = spyOn(PartContent, "textBlocks").mockImplementation((key, value, signal) =>
    (async function* () {
      for await (const block of original(key, value, signal)) {
        yield block
        break
      }
      entered()
      try {
        await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
        })
      } finally {
        stopped = true
      }
    })(),
  )
  let identity!: Awaited<ReturnType<typeof message>>
  let id!: string
  let version!: string
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          identity = await message()
          id = Identifier.ascending("part")
          const part: MessageV2.TextPart = {
            ...identity,
            id,
            type: "text",
            text: "stop with the Runtime".repeat(10000),
          }
          await Session.updatePartDelta(part, part.text)
          await Session.flushPartWrites(identity.sessionID)
          const preparation = await SessionHistory.preparePartFields({ ...identity, partID: id })
          version = preparation.version
          expect(preparation.state).toBe("preparing")
          await started
        },
      }),
    )
    await runtime.close()
    expect(stopped).toBe(true)
  } finally {
    await runtime.close()
  }
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(async () => {
    expect(
      await SessionPartFieldCache.inspect(
        ["sessions", "home", identity.sessionID, "messages", identity.messageID, "parts", id],
        "text",
        version,
      ),
    ).toBeUndefined()
  })
}, 15000)

test("a failed native preparation preserves its error and a later request can retry the same revision", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const identity = await message()
        const id = Identifier.ascending("part")
        const body = "retry the same native field🌏".repeat(10000)
        await Session.updatePartDelta({ ...identity, id, type: "text", text: body }, body)
        await Session.flushPartWrites(identity.sessionID)
        const original = PartContent.textBlocks
        let attempts = 0
        using once = spyOn(PartContent, "textBlocks").mockImplementation((...args) =>
          (async function* () {
            if (++attempts === 1) throw new Error("recoverable native field fixture failure")
            yield* original(...args)
          })(),
        )
        await expect(SessionHistory.partFieldDescriptor({ ...identity, partID: id })).rejects.toThrow(
          "recoverable native field fixture failure",
        )
        const ready = await SessionHistory.partFieldDescriptor({ ...identity, partID: id })
        expect(ready.fields[0]).toMatchObject({
          field: "text",
          bytes: Buffer.byteLength(body),
          sha256: sha(Buffer.from(body)),
        })
        expect(attempts).toBe(2)
      },
    }),
  )
}, 15000)
