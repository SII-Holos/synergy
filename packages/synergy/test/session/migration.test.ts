import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Identifier } from "../../src/id/id"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

const projectRoot = path.join(__dirname, "../..")

async function addUserMessage(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

async function addTerminalAssistantMessage(sessionID: string, parentID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: projectRoot, root: projectRoot },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
}

describe("session migrations", () => {
  test("repairs stale pendingReply flags without clearing genuinely pending sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const completed = await Session.create({})
        const completedUser = await addUserMessage(completed.id)
        await addTerminalAssistantMessage(completed.id, completedUser.id)
        await Session.update(completed.id, (draft) => {
          draft.pendingReply = true
        })

        const pending = await Session.create({})
        await addUserMessage(pending.id)
        await Session.update(pending.id, (draft) => {
          draft.pendingReply = true
        })

        const migration = migrations.find((entry) => entry.id === "20260619-session-repair-stale-pending-reply")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const completedAfter = await SessionManager.getSession(completed.id)
        const pendingAfter = await SessionManager.getSession(pending.id)

        expect(completedAfter?.pendingReply).toBeUndefined()
        expect(pendingAfter?.pendingReply).toBe(true)
      },
    })
  })

  test("migrates legacy file parts and artifact-only tool metadata to attachments", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const userMessage = Identifier.asMessageID(user.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)

        await Storage.write(StoragePath.messagePart(scope, sid, userMessage, Identifier.asPartID("part_file")), {
          id: "part_file",
          sessionID: session.id,
          messageID: user.id,
          type: "file",
          mime: "image/png",
          filename: "old.png",
          url: "data:image/png;base64,AAAA",
          metadata: { kind: "artifact", artifact: { sourcePath: "/tmp/old.png", size: 4 } },
        })

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "plugin_test",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Plugin",
            metadata: {
              display: {
                visibility: "media",
                presentation: "artifact-only",
                primaryAttachmentIds: ["tool_file"],
              },
            },
            time: { start: 1, end: 2 },
            attachments: [
              {
                id: "tool_file",
                sessionID: session.id,
                messageID: assistant.id,
                type: "file",
                mime: "image/png",
                filename: "tool.png",
                url: "asset://tool.png",
                metadata: { kind: "artifact", artifact: { originTool: "plugin_test", size: 12 } },
              },
            ],
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260630-session-attachment-parts")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const userPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, userMessage, Identifier.asPartID("part_file")),
        )
        expect(userPart.type).toBe("attachment")
        expect(userPart.presentation).toEqual({ mode: "card" })
        expect(userPart.model).toEqual({ mode: "provider-file", summary: "old.png (image/png)" })
        expect(userPart.metadata).toEqual({
          kind: "attachment",
          attachment: { sourcePath: "/tmp/old.png", size: 4 },
        })

        const toolPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        expect(toolPart.state.metadata.display.presentation).toBe("attachment-only")
        expect(toolPart.state.metadata.display.kind).toBe("media-generation")
        expect(toolPart.state.metadata.display.toolCard).toBe("hidden")
        expect(toolPart.state.metadata.display.visibility).toBeUndefined()
        expect(toolPart.state.attachments[0].type).toBe("attachment")
        expect(toolPart.state.attachments[0].model).toEqual({
          mode: "summary",
          summary: "tool.png (image/png)",
        })
        expect(toolPart.state.attachments[0].metadata).toEqual({
          kind: "attachment",
          attachment: { originTool: "plugin_test", size: 12 },
        })
      },
    })
  })

  test("migrates media display visibility into explicit hidden tool card policy", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "plugin_test",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Plugin",
            metadata: { display: { visibility: "media", presentation: "attachment-only" } },
            time: { start: 1, end: 2 },
            attachments: [],
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260630-session-tool-card-display")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const toolPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        expect(toolPart.state.metadata.display).toEqual({
          kind: "media-generation",
          presentation: "attachment-only",
          toolCard: "hidden",
        })
      },
    })
  })
})
