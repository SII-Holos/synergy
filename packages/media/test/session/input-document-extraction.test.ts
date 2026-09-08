import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerDocumentExtraction } from "../../src/register-documents"

registerDocumentExtraction()
const primaryModel = { providerID: "primary-provider", modelID: "primary-model" }
const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

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
