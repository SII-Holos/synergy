import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Asset } from "../../src/asset/asset"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { createUserMessage } from "../../src/session/input"
import { SessionInputStatus } from "../../src/session/input-status"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const model = { providerID: "test", modelID: "test" }
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=",
  "base64",
)
const fixtures = [
  { filename: "image.png", mime: "image/png", bytes: png },
  { filename: "image.jpg", mime: "image/jpeg", bytes: Buffer.from([255, 216, 255, 217]) },
  { filename: "notes.txt", mime: "text/plain", bytes: Buffer.from("TEXT_ATTACHMENT_MARKER") },
  { filename: "notes.md", mime: "text/markdown", bytes: Buffer.from("# MARKDOWN_ATTACHMENT_MARKER") },
  { filename: "data.json", mime: "application/json", bytes: Buffer.from('{"value":"JSON_ATTACHMENT_MARKER"}') },
  { filename: "data.csv", mime: "text/csv", bytes: Buffer.from("value\nCSV_ATTACHMENT_MARKER") },
  { filename: "sound.wav", mime: "audio/wav", bytes: Buffer.from("RIFF transport fixture") },
  { filename: "movie.mp4", mime: "video/mp4", bytes: Buffer.from("video transport fixture") },
  { filename: "trace.bin", mime: "application/octet-stream", bytes: Buffer.from([0, 1, 2, 255]) },
]

test("text uploads retain replacement decoding for legacy byte sequences", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const bytes = Buffer.concat([Buffer.from("LEGACY_CONTENT,"), Buffer.from([0xe9]), Buffer.from("\nEND")])
        for (const mime of ["text/plain", "text/csv"]) {
          const filename = mime === "text/plain" ? "legacy.txt" : "legacy.csv"
          const id = await Asset.write(bytes, mime, filename)
          for (const url of [`asset://${id}`, `data:${mime};base64,${bytes.toString("base64")}`]) {
            const session = await Session.create({ workspace: null })
            const message = await createUserMessage({
              sessionID: session.id,
              model,
              parts: [{ type: "attachment", url, filename, mime }],
            })
            expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("LEGACY_CONTENT,�\\nEND")
            const attachment = message.parts.find((part) => part.type === "attachment")!
            expect(await Bun.file(attachment.localPath!).bytes()).toEqual(new Uint8Array(bytes))
          }
        }
      },
    }),
  ))

test("content policy without embedded text still extracts uploaded and inline text", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const bytes = Buffer.from("CONTENT_TO_EXTRACT")
        const id = await Asset.write(bytes, "text/plain", "notes.txt")
        for (const url of [`asset://${id}`, `data:text/plain;base64,${bytes.toString("base64")}`]) {
          const session = await Session.create({ workspace: null })
          const message = await createUserMessage({
            sessionID: session.id,
            model,
            parts: [{ type: "attachment", url, filename: "notes.txt", mime: "text/plain", model: { mode: "content" } }],
          })
          expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("CONTENT_TO_EXTRACT")
        }
      },
    }),
  ))

test("explicit text attachment policies never create an extra extracted body", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bytes = Buffer.from("PRIVATE_ATTACHMENT_BODY")
        const id = await Asset.write(bytes, "text/plain", "notes.txt")
        const filepath = `${tmp.path}/notes.txt`
        await Bun.write(filepath, bytes)
        const policies: MessageV2.AttachmentModelPolicy[] = [
          { mode: "none" },
          { mode: "summary", summary: "only this summary" },
          { mode: "content", text: "only this content" },
          { mode: "provider-file" },
        ]
        for (const url of [
          `asset://${id}`,
          `data:text/plain;base64,${bytes.toString("base64")}`,
          pathToFileURL(filepath).href,
        ]) {
          for (const policy of policies) {
            const session = await Session.create({})
            const message = await createUserMessage({
              sessionID: session.id,
              model,
              parts: [{ type: "attachment", url, mime: "text/plain", filename: "notes.txt", model: policy }],
            })
            expect(message.parts.filter((part) => part.type === "text")).toHaveLength(0)
            expect(message.parts.find((part) => part.type === "attachment")?.model).toEqual(policy)
          }
        }
      },
    })
  }))

for (const context of ["home", "project", "workspace"] as const) {
  for (const source of ["asset", "data"] as const) {
    test(`${source} attachments preserve bytes and text in ${context} sessions`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        await ScopeContext.provide({
          scope: context === "home" ? Scope.home() : await tmp.scope(),
          ...(context !== "workspace" ? { workspace: null } : {}),
          fn: async () => {
            for (const fixture of fixtures) {
              const session = await Session.create(context === "workspace" ? {} : { workspace: null })
              expect(Boolean(session.workspace)).toBe(context === "workspace")
              const url =
                source === "asset"
                  ? `asset://${await Asset.write(fixture.bytes, fixture.mime, fixture.filename)}`
                  : `data:${fixture.mime};base64,${fixture.bytes.toString("base64")}`
              const message = await createUserMessage({
                sessionID: session.id,
                model,
                parts: [{ type: "attachment", filename: fixture.filename, mime: fixture.mime, url }],
              })
              const attachment = message.parts.find((part) => part.type === "attachment")
              expect(attachment?.filename).toBe(fixture.filename)
              expect(attachment?.localPath).toBeString()
              expect(await Bun.file(attachment!.localPath!).bytes()).toEqual(new Uint8Array(fixture.bytes))
              if (fixture.filename.match(/\.(txt|md|json|csv)$/)) {
                expect(JSON.stringify(MessageV2.toModelMessage([message]))).toContain("ATTACHMENT_MARKER")
              }
            }
          },
        })
      }))
  }
}

for (const source of ["asset", "data"] as const) {
  test(`${source} preparation preserves explicit model and presentation policies`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const policies: MessageV2.AttachmentModelPolicy[] = [
            { mode: "none" },
            { mode: "summary", summary: "custom summary" },
            { mode: "content", text: "custom content" },
            { mode: "provider-file" },
          ]
          for (const policy of policies) {
            const session = await Session.create({})
            const url =
              source === "asset"
                ? `asset://${await Asset.write(png, "image/png")}`
                : `data:image/png;base64,${png.toString("base64")}`
            const message = await createUserMessage({
              sessionID: session.id,
              model,
              parts: [
                {
                  type: "attachment",
                  url,
                  filename: "policy.png",
                  mime: "image/png",
                  model: policy,
                  presentation: { hidden: true },
                  metadata: { caption: "keep metadata" },
                },
              ],
            })
            const attachment = message.parts.find((part) => part.type === "attachment")
            expect(attachment?.model).toEqual(policy)
            expect(attachment?.presentation).toEqual({ hidden: true })
            expect(attachment?.metadata?.caption).toBe("keep metadata")
            const projected = MessageV2.toModelMessage([message])
            if (policy.mode === "none") expect(projected).toEqual([])
            if (policy.mode === "content") expect(JSON.stringify(projected)).toContain("custom content")
          }
        },
      })
    }))
}

test("excluded text attachments do not leak extracted text into model input", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({})
        const message = await createUserMessage({
          sessionID: session.id,
          model,
          parts: [
            {
              type: "attachment",
              filename: "private.txt",
              mime: "text/plain",
              model: { mode: "none" },
              url: `data:text/plain;base64,${Buffer.from("EXCLUDED_TEXT").toString("base64")}`,
            },
          ],
        })
        expect(MessageV2.toModelMessage([message])).toEqual([])
      },
    }),
  ))

test("a missing asset parks only its input and can be retried after repair", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({})
        await createUserMessage({ sessionID: session.id, model, parts: [{ type: "text", text: "seed" }] })
        const id = await Asset.write(png, "image/png")
        const filepath = Asset.resolvePath(id)!
        await fs.unlink(filepath)
        const bad = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model,
          parts: [
            { type: "text", text: "preserve the whole request" },
            { type: "attachment", url: `asset://${id}`, mime: "image/png", filename: "missing.png" },
          ],
        })
        const good = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model,
          parts: [{ type: "text", text: "next request" }],
        })
        expect((await SessionInbox.materializeNextTask(session.id)).status).toBe("failed")
        const failure = await SessionInbox.getStored(session.id, bad.id)
        expect(failure.failReason).toContain("missing.png")
        expect(failure.input?.parts).toHaveLength(2)
        expect((await SessionInputStatus.get({ sessionID: session.id, messageID: good.messageID })).state).toBe(
          "accepted",
        )
        expect((await SessionInbox.materializeNextTask(session.id)).status).toBe("materialized")
        await Bun.write(filepath, png)
        await SessionInbox.rearm({ sessionID: session.id, itemID: bad.id })
        expect((await SessionInbox.materializeNextTask(session.id)).status).toBe("materialized")
        expect(
          (await MessageV2.parts({ sessionID: session.id, messageID: bad.messageID })).some(
            (part) => part.type === "attachment",
          ),
        ).toBe(true)
      },
    }),
  ))

test("a workspace-free attachment cannot import an arbitrary file or escape the managed root", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const outside = `${tmp.path}/outside.png`
    await Bun.write(outside, png)
    await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const linkID = "0123456789abcdef.png"
        await fs.symlink(outside, Asset.filePath(linkID))
        for (const url of [pathToFileURL(outside).href, `asset://${linkID}`]) {
          const session = await Session.create({})
          await expect(
            createUserMessage({
              sessionID: session.id,
              model,
              parts: [{ type: "attachment", url, filename: "outside.png", mime: "image/png" }],
            }),
          ).rejects.toMatchObject({ name: "AttachmentPreparationError" })
        }
      },
    })
  }))

afterAll(() => runtime.close())
