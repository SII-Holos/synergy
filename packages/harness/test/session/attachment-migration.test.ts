import { afterAll, expect, test } from "bun:test"
import { Asset } from "../../src/asset/asset"
import { Identifier } from "../../src/id/id"
import { MigrationRegistry } from "../../src/migration/registry"
import { upgradeImportedRecord } from "../../src/migration/import"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("attachment purpose upgrades historical tool evidence and refreshes only the owning display index", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        const asset = await Asset.write(Buffer.from("retained image bytes"), "image/png", "chart.png")
        const file: MessageV2.AttachmentPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "attachment",
          mime: "image/png",
          filename: "chart.png",
          url: `asset://${asset}`,
          presentation: { size: "large" },
          metadata: { retained: "annotation" },
        }
        const part: MessageV2.ToolPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "tool",
          tool: "view_image",
          callID: "call",
          state: {
            status: "completed",
            input: {},
            output: "Loaded image",
            title: "Image",
            time: { start: 1, end: 2 },
            metadata: {},
            attachments: [
              file,
              {
                ...file,
                id: Identifier.ascending("part"),
                metadata: { attachment: { deliverable: true, sourcePath: "chart.png" } },
              },
            ],
          },
        }
        await Session.updatePart(part)
        const key = StoragePath.messagePart(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          messageID,
          Identifier.asPartID(part.id),
        )
        const before = await Storage.read<MessageV2.ToolPart>(key)
        if (before.state.status !== "completed") throw new Error("Expected completed tool")
        const stateKey = ["sessions", session.scope.id, session.id, "display_parts_state", messageID]
        const foreignKey = ["sessions", other.scope.id, other.id, "display_parts_state", messageID]
        const state = { ready: true, generation: 7, cursor: part.id, sourceGeneration: 7 }
        await Storage.write(stateKey, state)
        await Storage.write(foreignKey, state)
        const migration = MigrationRegistry.list()
          .get("session")!
          .find((item) => item.id === "20261007-attachment-presentation")
        expect(migration).toBeDefined()
        const records = await Storage.query<MessageV2.Part>({
          kind: "part",
          scopeID: session.scope.id,
          sessionID: session.id,
        })
        expect(records.map((item) => item.key)).toContainEqual(key)
        const phases: number[] = []
        await migration!.upSession!(
          { scopeID: session.scope.id, sessionID: session.id },
          (_current, _total, phase?: number) => {
            if (phase !== undefined) phases.push(phase)
          },
        )
        expect([...new Set(phases)]).toEqual([0, 1])
        const saved = await Storage.read<MessageV2.ToolPart>(key)
        expect(saved.state.status).toBe("completed")
        if (saved.state.status !== "completed") throw new Error("Expected completed tool")
        expect(saved.state.attachments?.[0]).toEqual({
          ...before.state.attachments![0],
          presentation: { size: "large", purpose: "evidence" },
        })
        expect(saved.state.attachments?.[1].presentation?.purpose).toBe("deliverable")
        expect(saved.state.attachments?.[1].metadata?.attachment).toEqual({ sourcePath: "chart.png" })
        expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual({ ready: false, generation: 8 })
        expect(await Storage.read<Record<string, unknown>>(foreignKey)).toEqual(state)
        await migration!.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect(await Storage.read<MessageV2.ToolPart>(key)).toEqual(saved)
        expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual({ ready: false, generation: 8 })
        expect(upgradeImportedRecord(key, before)).toEqual(saved)
        const summary = (await SessionHistoryDisplay.partPage({ sessionID: session.id, messageID }, session.scope.id))
          .items[0]
        expect(summary.attachments).toEqual({ evidence: 1, deliverable: 1, references: [file.url] })
        expect(summary.display).toBe("activity")
        expect(part.state.status === "completed" && part.state.attachments?.[0].presentation?.purpose).toBeUndefined()

        const cancelled: MessageV2.ToolPart = {
          ...part,
          tool: "openai_image_gen",
          state: {
            status: "error",
            reason: "cancelled",
            input: {},
            error: "Operation aborted",
            time: { start: 1, end: 2 },
            metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
          },
        }
        await Session.updatePart(cancelled)
        await Storage.write(stateKey, state)
        const cancellationMigration = MigrationRegistry.list()
          .get("session")!
          .find((item) => item.id === "20261007-media-cancellation-display")
        expect(cancellationMigration).toBeDefined()
        await cancellationMigration!.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect(await Storage.read<MessageV2.ToolPart>(key)).toEqual(cancelled)
        expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual({ ready: false, generation: 8 })
        expect(await Storage.read<Record<string, unknown>>(foreignKey)).toEqual(state)
        await cancellationMigration!.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect(await Storage.read<Record<string, unknown>>(stateKey)).toEqual({ ready: false, generation: 8 })
        expect(upgradeImportedRecord(key, cancelled)).toEqual(cancelled)
        expect(upgradeImportedRecord(stateKey, state)).toEqual({ ready: false, generation: 8 })
        const refreshed = await SessionHistoryDisplay.partPage({ sessionID: session.id, messageID }, session.scope.id)
        expect(refreshed.items[0].render).toBe(false)
        await Session.remove(session.id)
        await Session.remove(other.id)
      },
    })
  }))

test("imported attachment purposes preserve explicit current values and tolerate malformed sibling evidence", () =>
  runtime.run(() => {
    const key = ["sessions", "scope", "session", "messages", "message", "parts", "part"]
    const current = {
      type: "attachment",
      presentation: { purpose: "deliverable", crop: true },
      metadata: { attachment: { deliverable: false }, custom: 2 },
    }
    const legacy = {
      type: "tool",
      tool: "bash",
      state: {
        attachments: [
          null,
          "unknown",
          current,
          { type: "attachment", metadata: { attachment: { detectedFrom: "path" } } },
          { type: "attachment", metadata: null },
        ],
      },
    }
    const expected = {
      ...legacy,
      state: {
        attachments: [
          null,
          "unknown",
          { ...current, metadata: { attachment: {}, custom: 2 } },
          {
            type: "attachment",
            metadata: { attachment: { detectedFrom: "path" } },
            presentation: { purpose: "evidence" },
          },
          { type: "attachment", metadata: null, presentation: { purpose: "deliverable" } },
        ],
      },
    }
    expect(upgradeImportedRecord(key, legacy)).toEqual(expected)
    expect(upgradeImportedRecord(key, expected)).toEqual(expected)
  }))
