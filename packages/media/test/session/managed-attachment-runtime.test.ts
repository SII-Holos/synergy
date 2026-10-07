import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { afterAll, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LookAtTool } from "../../src/tools/lookat"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
runtime.run(() => Log.init({ print: false }))
const model = { providerID: "attachment-test", modelID: "text" }
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=",
  "base64",
)

type RequestBody = { model: string; messages: unknown[] }
async function withProvider(body: (requests: RequestBody[]) => Promise<void>) {
  const requests: RequestBody[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as RequestBody
      requests.push(input)
      const chunks = [
        {
          id: `response_${requests.length}`,
          choices: [{ index: 0, delta: { role: "assistant", content: "ATTACHMENT_OK" }, finish_reason: null }],
        },
        {
          id: `response_${requests.length}`,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    await using tmp = await tmpdir({
      config: {
        model: "attachment-test/text",
        vision_model: "attachment-test/vision",
        compaction: { auto: false },
        provider: {
          "attachment-test": {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
            models: {
              text: { name: "Text", tool_call: true, limit: { context: 128000, output: 2048 } },
              vision: {
                name: "Vision",
                attachment: true,
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 128000, output: 2048 },
              },
            },
          },
        },
      },
    })
    await ScopeContext.provide({ scope: await tmp.scope(), workspace: null, fn: () => body(requests) })
  } finally {
    await server.stop(true)
  }
}

test("workspace file content policy preserves native selected-line reading", () =>
  runtime.run(() =>
    withProvider(async () => {
      const session = await Session.create({ title: "Native file selection" })
      expect(session.workspace).not.toBeNull()
      await ScopeContext.provide({
        scope: session.scope,
        workspace: session.workspace,
        fn: async () => {
          const filepath = `${ScopeContext.current.directory}/selected.txt`
          await Bun.write(filepath, "BEFORE_SELECTION\nSELECTED_CONTENT\nSELECTED_MORE\nAFTER_SELECTION\n")
          const message = await createUserMessage({
            sessionID: session.id,
            model,
            parts: [
              {
                type: "attachment",
                url: pathToFileURL(filepath).href + "?start=2&end=3",
                mime: "text/plain",
                filename: "selected.txt",
                model: { mode: "content" },
              },
            ],
          })
          const projected = JSON.stringify(MessageV2.toModelMessage([message]))
          expect(projected).toContain("SELECTED_CONTENT")
          expect(projected).not.toContain("BEFORE_SELECTION")
          expect(projected).not.toContain("AFTER_SELECTION")
        },
      })
    }),
  ))

test("the primary model receives image bytes while history retains the immutable asset reference", () =>
  runtime.run(() =>
    withProvider(async (requests) => {
      const id = await Asset.write(png, "image/png", "chart.png")
      const session = await Session.create({ workspace: null, title: "Image input transport" })
      const message = await createUserMessage({
        sessionID: session.id,
        model: { providerID: model.providerID, modelID: "vision" },
        parts: [
          { type: "text", text: "Read this image" },
          { type: "attachment", url: `asset://${id}`, mime: "image/png", filename: "chart.png" },
        ],
      })
      try {
        await SessionInvoke.loop.force(session.id)
        const request = requests.find((entry) => entry.model === "vision")
        expect(request).toBeDefined()
        expect(JSON.stringify(request!.messages)).toContain(`data:image/png;base64,${png.toString("base64")}`)
        expect(JSON.stringify(request!.messages)).toContain(`Reference: asset://${id}`)
        const saved = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        expect(saved.parts.find((part) => part.type === "attachment")?.url).toBe(`asset://${id}`)
      } finally {
        await SessionInvoke.cancel(session.id)
      }
    }),
  ))

test(
  "a failed uploaded task does not block the next task or contaminate its provider request",
  () =>
    runtime.run(() =>
      withProvider(async (requests) => {
        const session = await Session.create({
          title: "Attachment queue integration",
          controlProfile: "full_access",
          workspace: null,
        })
        const bad = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model,
          parts: [
            { type: "text", text: "DO_NOT_SEND_PARTIAL_INPUT" },
            { type: "attachment", url: "asset://0000000000000000.png", filename: "missing.png", mime: "image/png" },
          ],
        })
        const asset = await Asset.write(Buffer.from("ACTUAL_ATTACHMENT_CONTENT"), "text/plain", "notes.txt")
        const good = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model,
          parts: [
            { type: "text", text: "Read the attachment" },
            { type: "attachment", url: `asset://${asset}`, filename: "notes.txt", mime: "text/plain" },
          ],
        })
        try {
          await SessionManager.wake(session.id)
          expect(requests).toHaveLength(1)
          expect(JSON.stringify(requests[0].messages)).toContain("ACTUAL_ATTACHMENT_CONTENT")
          expect(JSON.stringify(requests[0].messages)).not.toContain("DO_NOT_SEND_PARTIAL_INPUT")
          expect((await SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID })).state).toBe(
            "failed",
          )
          const deadline = Date.now() + 45_000
          while (
            (await SessionInputStatus.get({ sessionID: session.id, messageID: good.messageID })).state !== "completed"
          ) {
            if (Date.now() > deadline) throw new Error("The queued input did not complete")
            await Bun.sleep(10)
          }
          expect((await SessionInbox.list(session.id)).map((item) => item.id)).toEqual([bad.id])
        } finally {
          await SessionInvoke.cancel(session.id)
        }
      }),
    ),
  60_000,
)

test(
  "failed steer and context attachments leave the active root runnable",
  () =>
    runtime.run(() =>
      withProvider(async (requests) => {
        const session = await Session.create({
          title: "Attachment injection integration",
          controlProfile: "full_access",
          workspace: null,
        })
        await createUserMessage({ sessionID: session.id, model, parts: [{ type: "text", text: "VALID_ROOT_CONTENT" }] })
        const items = []
        for (const mode of ["steer", "context"] as const) {
          items.push(
            await SessionInbox.deliver({
              sessionID: session.id,
              mode,
              message: {
                role: "user",
                model,
                parts: [
                  { type: "text", text: "DO_NOT_SEND_PARTIAL_INPUT" },
                  {
                    type: "attachment",
                    url: "data:text/plain;base64,!!!",
                    filename: `${mode}.txt`,
                    mime: "text/plain",
                  },
                ],
              },
            }),
          )
        }
        try {
          await SessionInvoke.loop.force(session.id)
          expect(requests).toHaveLength(1)
          expect(JSON.stringify(requests[0].messages)).toContain("VALID_ROOT_CONTENT")
          expect(JSON.stringify(requests[0].messages)).not.toContain("DO_NOT_SEND_PARTIAL_INPUT")
          for (const item of items)
            expect((await SessionInbox.getStored(session.id, item.itemID)).status).toBe("failed")
        } finally {
          await SessionInvoke.cancel(session.id)
        }
      }),
    ),
  60_000,
)

test(
  "look_at delivers managed image bytes to a real child invocation without a workspace",
  () =>
    runtime.run(() =>
      withProvider(async (requests) => {
        const session = await Session.create({
          title: "Vision attachment integration",
          controlProfile: "full_access",
          workspace: null,
        })
        const parent = await createUserMessage({
          sessionID: session.id,
          model,
          parts: [{ type: "text", text: "parent" }],
        })
        const id = await Asset.write(png, "image/png")
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: Asset.resolvePath(id)!, goal: "Describe", show_to_user: true },
          {
            sessionID: session.id,
            messageID: parent.info.id,
            agent: PrimaryAgentIdentity.names.general,
            abort: new AbortController().signal,
            metadata: () => {},
            ask: async () => {},
          },
        )
        expect(result.output).toContain("ATTACHMENT_OK")
        expect(requests).toHaveLength(1)
        expect(requests[0].model).toBe("vision")
        expect(JSON.stringify(requests[0].messages)).toContain(`data:image/png;base64,${png.toString("base64")}`)
        const children = await Session.children(session.id)
        expect(children).toHaveLength(1)
        expect(children[0].workspace).toBeNull()
        expect(result.attachments).toHaveLength(1)
        const messages = await Session.messages({ sessionID: children[0].id })
        expect(messages.some((message) => message.parts.some((part) => part.type === "attachment"))).toBe(true)
      }),
    ),
  60_000,
)
