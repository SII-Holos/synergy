import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Attachment } from "../../src/attachment"
import { Asset } from "../../src/asset/asset"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

describe("session attachment transport", () => {
  test("stores summary attachments as asset references instead of data URLs", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        try {
          const filepath = path.join(tmp.path, "doc.pdf")
          await Bun.write(filepath, "fake pdf bytes")

          const part = await Attachment.toPart({
            filepath,
            mime: "application/pdf",
            filename: "doc.pdf",
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
          })

          expect(part.url.startsWith("asset://")).toBe(true)
          expect(part.url.startsWith("data:")).toBe(false)

          const asset = await Asset.read(part.url.slice("asset://".length))
          expect(await asset?.text()).toBe("fake pdf bytes")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("externalizes legacy non-provider-file data URL attachments when reading parts", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        try {
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            time: { created: Date.now(), completed: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: tmp.path, root: tmp.path },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          const legacyBytes = Buffer.from("legacy pdf bytes")
          const partID = Identifier.ascending("part")
          await Session.updatePart({
            id: partID,
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            callID: "call_legacy",
            tool: "read",
            state: {
              status: "completed",
              input: {},
              output: "read",
              outputBytes: 4,
              title: "read",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
              attachments: [
                {
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "attachment",
                  mime: "application/pdf",
                  filename: "legacy.pdf",
                  url: `data:application/pdf;base64,${legacyBytes.toString("base64")}`,
                  model: { mode: "summary", summary: "legacy.pdf (application/pdf)" },
                },
              ],
            },
          })

          const parts = await MessageV2.parts({ sessionID: session.id, messageID: assistant.id })
          const tool = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
          const attachment = tool?.state.status === "completed" ? tool.state.attachments?.[0] : undefined

          expect(attachment?.url.startsWith("asset://")).toBe(true)
          expect(attachment?.url.startsWith("data:")).toBe(false)
          expect((attachment?.metadata?.attachment as { size?: number } | undefined)?.size).toBe(legacyBytes.length)

          const persisted = await Storage.read<MessageV2.ToolPart>(
            StoragePath.messagePart(
              Identifier.asScopeID(scope.id),
              Identifier.asSessionID(session.id),
              Identifier.asMessageID(assistant.id),
              partID,
            ),
          )
          const persistedAttachment =
            persisted.state.status === "completed" ? persisted.state.attachments?.[0] : undefined
          expect(persistedAttachment?.url).toBe(attachment?.url)
          expect(await (await Asset.read(attachment!.url.slice("asset://".length)))?.text()).toBe("legacy pdf bytes")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })
})
