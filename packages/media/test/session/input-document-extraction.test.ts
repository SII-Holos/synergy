import { afterAll, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createPptx } from "@ericsanchezok/synergy-testing/pptx"
import { testRuntime } from "../support/runtime"
import { createDocx, createPdf, createXlsx } from "../support/documents"

const runtime = await testRuntime()
const model = { providerID: "test", modelID: "test" }
const mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

for (const [extension, mime, make] of [
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", createDocx],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createXlsx],
  ["pdf", "application/pdf", createPdf],
] as const) {
  test(
    `${extension} uploads and inline attachments deliver extracted text without a workspace`,
    () =>
      runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          workspace: null,
          fn: async () => {
            const bytes = await make("DOCUMENTCONTENTMARKER")
            const filename = `document.${extension}`
            for (const url of [
              `asset://${await Asset.write(bytes, mime, filename)}`,
              `data:${mime};base64,${bytes.toString("base64")}`,
            ]) {
              const session = await Session.create({ workspace: null })
              const partID = Identifier.ascending("part")
              const message = await createUserMessage({
                sessionID: session.id,
                model,
                parts: [{ id: partID, type: "attachment", url, filename, mime, presentation: { renderer: "file" } }],
              })
              expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("DOCUMENTCONTENTMARKER")
              expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain(filename)
              const saved = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
              const attachment = saved.parts.find((part) => part.id === partID)
              expect(attachment).toMatchObject({
                type: "attachment",
                filename,
                mime,
                presentation: { renderer: "file" },
              })
              if (attachment?.type !== "attachment") throw new Error("The original document was not retained")
              expect(attachment.url).toStartWith("asset://")
              expect(await Bun.file(attachment.localPath!).bytes()).toEqual(new Uint8Array(bytes))
              expect(JSON.stringify(MessageV2.toModelMessage([saved]))).not.toContain(bytes.toString("base64"))
            }
          },
        }),
      ),
    30_000,
  )
}

for (const source of ["asset", "data", "file"] as const) {
  for (const valid of [true, false]) {
    test(`${source} document ${valid ? "delivers extracted text" : "parks the complete input on extraction failure"}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        await ScopeContext.provide({
          scope: source === "file" ? await tmp.scope() : Scope.home(),
          ...(source !== "file" ? { workspace: null } : {}),
          fn: async () => {
            const bytes = valid
              ? Buffer.from(await createPptx(["DOCUMENTCONTENTMARKER"]))
              : Buffer.from("broken pptx archive")
            const filename = "slides.pptx"
            const filepath = `${tmp.path}/${filename}`
            await Bun.write(filepath, bytes)
            const url =
              source === "asset"
                ? `asset://${await Asset.write(bytes, mime, filename)}`
                : source === "data"
                  ? `data:${mime};base64,${bytes.toString("base64")}`
                  : pathToFileURL(filepath).href
            const session = await Session.create({})
            await createUserMessage({ sessionID: session.id, model, parts: [{ type: "text", text: "seed" }] })
            const item = await SessionInbox.enqueueUser({
              sessionID: session.id,
              model,
              parts: [
                { type: "text", text: "Keep this request intact" },
                { type: "attachment", url, filename, mime },
                {
                  type: "attachment",
                  url: `data:text/plain;base64,${Buffer.from("valid sibling").toString("base64")}`,
                  filename: "sibling.txt",
                  mime: "text/plain",
                },
              ],
            })
            const outcome = await SessionInbox.materializeNextTask(session.id)
            expect(outcome.status).toBe(valid ? "materialized" : "failed")
            if (valid) {
              const message = await MessageV2.get({ sessionID: session.id, messageID: item.messageID })
              expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("DOCUMENTCONTENTMARKER")
              const attachment = message.parts.find((part) => part.type === "attachment" && part.filename === filename)
              expect(attachment?.type).toBe("attachment")
              if (attachment?.type !== "attachment") throw new Error("The original slides were not retained")
              expect(await Bun.file(attachment.localPath!).bytes()).toEqual(new Uint8Array(bytes))
            } else {
              const failed = await SessionInbox.getStored(session.id, item.id)
              expect(failed.input?.parts).toHaveLength(3)
              expect(failed.failReason).toContain(filename)
              expect(failed.failReason).not.toContain(tmp.path)
              await expect(MessageV2.get({ sessionID: session.id, messageID: item.messageID })).rejects.toBeInstanceOf(
                Storage.NotFoundError,
              )
            }
          },
        })
      }))
  }
}

test("audio and structured text preserve their original attachment with the document processor registered", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        for (const [mime, filename, content] of [
          ["audio/wav", "sound.wav", "RIFF audio transport"],
          ["audio/mpeg", "sound.mp3", "audio transport"],
          ["text/csv", "table.csv", "field\nTEXT_MARKER"],
          ["application/json", "data.json", '{"field":"TEXT_MARKER"}'],
        ]) {
          const id = await Asset.write(Buffer.from(content), mime, filename)
          const session = await Session.create({})
          const message = await createUserMessage({
            sessionID: session.id,
            model,
            parts: [{ type: "attachment", url: `asset://${id}`, mime, filename }],
          })
          const attachment = message.parts.find((part) => part.type === "attachment")
          expect(attachment?.localPath).toBe(Asset.resolvePath(id))
          expect(await Bun.file(attachment!.localPath!).text()).toBe(content)
          if (filename.endsWith("csv") || filename.endsWith("json"))
            expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("TEXT_MARKER")
        }
      },
    }),
  ))

afterAll(() => runtime.close())
