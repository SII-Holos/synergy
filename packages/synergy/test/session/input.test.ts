import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { Asset } from "../../src/asset/asset"
import { Bus } from "../../src/bus"
import { FileTime } from "../../src/file/time"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { createUserMessage, lastModel } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const primaryModel = { providerID: "primary-provider", modelID: "primary-model" }
const subagentModel = { providerID: "subagent-provider", modelID: "subagent-model" }

const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

async function writeUser(input: {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  text: string
  metadata?: Record<string, any>
}) {
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: input.model,
    metadata: input.metadata,
  } satisfies MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  })
}

describe("session input identity anchors", () => {
  test("cortex completion messages do not replace the session model or agent anchor", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        await writeUser({
          sessionID: session.id,
          agent: "synergy",
          model: primaryModel,
          text: "primary request",
        })
        await writeUser({
          sessionID: session.id,
          agent: "developer",
          model: subagentModel,
          text: "background task completed",
          metadata: {
            source: "cortex",
            sourceSessionID: "ses_child0123456789",
          },
        })

        expect(await lastModel(session.id)).toEqual(primaryModel)

        const created = await createUserMessage({
          sessionID: session.id,
          model: primaryModel,
          parts: [{ type: "text", text: "next prompt" }],
        })

        expect(created.info.agent).toBe("synergy")
        expect(created.info.model).toEqual(primaryModel)
      },
    })
  })
})

describe("session input event ordering", () => {
  test("publishes a steer message before its parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await createUserMessage({
          sessionID: session.id,
          model: primaryModel,
          parts: [{ type: "text", text: "initial request" }],
        })
        const messageID = Identifier.ascending("message")
        const events: string[] = []
        const unsubMessage = Bus.subscribe(MessageV2.Event.Updated, (event) => {
          if (event.properties.info.id === messageID) events.push(event.type)
        })
        const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          if (event.properties.part.messageID === messageID) events.push(event.type)
        })

        try {
          await createUserMessage(
            {
              sessionID: session.id,
              messageID,
              model: primaryModel,
              noReply: true,
              parts: [{ type: "text", text: "steer this run" }],
            },
            root.info.id,
          )

          expect(events).toEqual(["message.updated", "message.part.updated"])
        } finally {
          unsubMessage()
          unsubPart()
          await Session.remove(session.id)
        }
      },
    })
  })
})

describe("session input attachment extraction", () => {
  test("preserves a file attachment when document extraction fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const bytes = Buffer.from("not a pptx archive")
        const filepath = `${tmp.path}/broken.pptx`
        await Bun.write(filepath, bytes)

        try {
          const created = await createUserMessage({
            sessionID: session.id,
            model: primaryModel,
            parts: [
              { type: "text", text: "Please inspect this presentation" },
              {
                type: "attachment",
                url: pathToFileURL(filepath).href,
                filename: "broken.pptx",
                mime: pptxMime,
                model: { mode: "summary", summary: `broken.pptx (${pptxMime})` },
              },
            ],
          })

          expect(
            created.parts.some((part) => part.type === "text" && part.text === "Please inspect this presentation"),
          ).toBe(true)
          expect(
            created.parts.some(
              (part) =>
                part.type === "text" &&
                part.origin === "system" &&
                part.text.startsWith("Failed to extract text from broken.pptx:"),
            ),
          ).toBe(true)

          const attachment = created.parts.find((part): part is MessageV2.AttachmentPart => part.type === "attachment")
          expect(attachment?.url.startsWith("asset://")).toBe(true)
          const asset = attachment ? await Asset.read(attachment.url.slice("asset://".length)) : undefined
          expect(Buffer.from(await asset!.arrayBuffer())).toEqual(bytes)
          expect(FileTime.get(session.id, filepath)).toBeInstanceOf(Date)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("preserves a data attachment when document extraction fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const bytes = Buffer.from("not a pptx archive")

        try {
          const created = await createUserMessage({
            sessionID: session.id,
            model: primaryModel,
            parts: [
              { type: "text", text: "Please inspect this presentation" },
              {
                type: "attachment",
                url: `data:${pptxMime};base64,${bytes.toString("base64")}`,
                filename: "broken.pptx",
                mime: pptxMime,
                model: { mode: "summary", summary: `broken.pptx (${pptxMime})` },
              },
            ],
          })

          expect(
            created.parts.some(
              (part) =>
                part.type === "text" &&
                part.origin === "system" &&
                part.text.startsWith("Failed to extract text from broken.pptx:"),
            ),
          ).toBe(true)

          const persisted = await MessageV2.parts({ sessionID: session.id, messageID: created.info.id })
          const attachment = persisted.find((part): part is MessageV2.AttachmentPart => part.type === "attachment")
          expect(attachment?.url.startsWith("asset://")).toBe(true)
          const asset = attachment ? await Asset.read(attachment.url.slice("asset://".length)) : undefined
          expect(Buffer.from(await asset!.arrayBuffer())).toEqual(bytes)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })
})
