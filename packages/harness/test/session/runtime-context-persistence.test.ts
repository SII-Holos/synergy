import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { RuntimeAdvisory } from "../../src/session/runtime-context"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { migrateRuntimeContext } from "../../src/session/runtime-context-migration"
import { upgradeAccessRecord, upgradeImportedRecord } from "../../src/migration/import"
import { StoragePath } from "../../src/storage/path"

test("legacy advisory upgrades preserve text and extensions through storage, access and import", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const id = Identifier.ascending("message")
        const key = StoragePath.messageInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          id,
        )
        const foreign = StoragePath.messageInfo(
          Identifier.asScopeID(other.scope.id),
          Identifier.asSessionID(other.id),
          id,
        )
        const text = "Original advisory text must remain byte-for-byte unchanged."
        const part = StoragePath.messagePart(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          id,
          Identifier.ascending("part"),
        )
        const value = {
          id,
          sessionID: session.id,
          role: "user",
          origin: RuntimeAdvisory.origin,
          metadata: {
            retained: true,
            runtimeContext: {
              version: 1,
              scope: "home",
              role: "user",
              contentHash: RuntimeAdvisory.knowledgeRevision(text),
              extension: "preserved",
              sources: [{ id: "git-health", state: "present", revision: "original", annotation: "retained" }],
            },
          },
        }
        await Storage.write(key, value)
        await Storage.write(foreign, { ...value, sessionID: other.id })
        await Storage.write(part, { type: "text", text })
        const expected = {
          ...value,
          metadata: {
            ...value.metadata,
            runtimeContext: {
              ...value.metadata.runtimeContext,
              version: 2,
              sources: [{ ...value.metadata.runtimeContext.sources[0], kind: "state" }],
            },
          },
        }
        expect(upgradeAccessRecord(key, value)).toMatchObject(expected)
        expect(upgradeImportedRecord(key, value)).toMatchObject(expected)
        expect(value.metadata.runtimeContext.version).toBe(1)
        await migrateRuntimeContext({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        await migrateRuntimeContext({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect(await Storage.read<typeof expected>(key)).toEqual(expected)
        expect((await Storage.read<typeof value>(foreign)).metadata.runtimeContext.version).toBe(1)
        expect(await Storage.read<{ type: string; text: string }>(part)).toEqual({ type: "text", text })
      },
    }),
  )
})

test("advisory messages survive reopen and fork before their associated output without becoming task roots", async () => {
  await using home = await tmpdir()
  const runtime = await testRuntime({ home: home.path })
  let sessionID = ""
  let original: MessageV2.WithParts[] = []
  const sources = [
    RuntimeAdvisory.present("memory", "Complete remembered facts"),
    { id: "git", state: "cleared" as const },
  ]
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          sessionID = session.id
          const rootID = Identifier.ascending("message")
          const root: MessageV2.User = {
            id: rootID,
            sessionID,
            role: "user",
            isRoot: true,
            rootID,
            visible: true,
            includeInContext: true,
            origin: { type: "user" },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          }
          await Session.updateMessage(root)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: rootID,
            type: "text",
            origin: "user",
            text: "Do the task",
          })
          const observation = RuntimeAdvisory.prepare({ scope: "home", sources, previous: [] })!
          const message = RuntimeAdvisory.message({
            id: Identifier.ascending("message"),
            partID: Identifier.ascending("part"),
            root,
            created: 2,
            observation,
          })
          const assistant: MessageV2.Assistant = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "assistant",
            rootID,
            parentID: rootID,
            visible: true,
            agent: "test",
            mode: "test",
            modelID: "test",
            providerID: "test",
            time: { created: 2, completed: 3 },
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          }
          await Session.updateMessage(assistant)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: assistant.id,
            type: "text",
            text: "Done",
          })
          await Storage.transaction(async () => {
            await Session.updateMessage(message.info)
            for (const part of message.parts) await Session.updatePart(part)
          })
          original = await Session.messages({ sessionID })
          expect(original.map((m) => m.info.id)).toEqual([rootID, message.info.id, assistant.id])
          expect(
            MessageV2.deriveSemantics(original).filter((m) => m.info.role === "user" && m.info.isRoot),
          ).toHaveLength(1)
          expect(original[1]!.info.visible).toBe(false)
          expect(MessageV2.projectModelMessages(original).messages.map((m) => m.role)).toEqual([
            "user",
            "user",
            "assistant",
          ])
          expect(
            RuntimeAdvisory.prepare({ scope: "home", sources, previous: [RuntimeAdvisory.read(original[1]!.info)!] }),
          ).toBeUndefined()
          const transformed = structuredClone(original)
          const changedPart = transformed[1]!.parts[0]!
          if (changedPart.type !== "text") throw new Error("Expected advisory text")
          changedPart.text = changedPart.text.replace("Complete remembered facts", "Changed by a plugin")
          expect(
            RuntimeAdvisory.prepare({ scope: "home", sources, previous: RuntimeAdvisory.history(transformed) })?.text,
          ).toContain("Complete remembered facts")
          expect(
            RuntimeAdvisory.prepare({ scope: "home", sources, previous: RuntimeAdvisory.history(original) }),
          ).toBeUndefined()
          const fork = await Session.fork({ sessionID })
          const copied = await Session.messages({ sessionID: fork.id })
          expect(MessageV2.projectModelMessages(copied).messages).toEqual(
            MessageV2.projectModelMessages(original).messages,
          )
          expect(copied.map((m) => m.info.rootID)).toEqual(copied.map(() => copied[0]!.info.id))
          expect(RuntimeAdvisory.read(copied[1]!.info)).toEqual(observation.metadata)
          const imported = await SessionImport.fromReport(await SessionExport.generate({ sessionID, mode: "full" }))
          const restored = await Session.messages({ sessionID: imported.rootSessionID })
          expect(MessageV2.projectModelMessages(restored).messages).toEqual(
            MessageV2.projectModelMessages(original).messages,
          )
          expect(restored.map((m) => m.info.rootID)).toEqual(restored.map(() => restored[0]!.info.id))
          expect(RuntimeAdvisory.history(restored)).toEqual([observation.metadata])
        },
      }),
    )
  } finally {
    await runtime.close()
  }
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const messages = await Session.messages({ sessionID })
        expect(MessageV2.projectModelMessages(messages).messages).toEqual(
          MessageV2.projectModelMessages(original).messages,
        )
        expect(
          RuntimeAdvisory.prepare({
            scope: "home",
            sources,
            previous: messages.flatMap((m) => RuntimeAdvisory.read(m.info) ?? []),
          }),
        ).toBeUndefined()
      },
    }),
  )
})
