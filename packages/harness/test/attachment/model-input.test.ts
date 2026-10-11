import { afterAll, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { serialize, deserialize } from "node:v8"
import { Asset } from "../../src/asset/asset"
import { materializeAttachmentInput } from "../../src/attachment/model-input"
import { AttachmentImageInput } from "../../src/attachment/image-input"
import { testRuntime } from "../support/runtime"

const bytes = Buffer.from("PROVIDER_IMAGE_BYTES")
let preparations = 0
const runtime = await testRuntime({
  register() {
    AttachmentImageInput.register(async (input, signal) => {
      signal.throwIfAborted()
      preparations++
      if (!Buffer.from(input).equals(bytes)) return { ok: false, reason: "invalid" }
      return {
        ok: true,
        data: bytes.toString("base64"),
        mediaType: "image/png",
        width: 100,
        height: 50,
        originalWidth: 100,
        originalHeight: 50,
      }
    })
  },
})
afterAll(() => runtime.close())

test("asset references become provider bytes only in the transient model request", () =>
  runtime.run(async () => {
    const id = await Asset.write(bytes, "image/png")
    const reference = `asset://${id}`
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `Show ![chart](${reference})` },
          { type: "image", image: new URL(reference), mediaType: "image/png" },
          { type: "file", data: new URL(reference), mediaType: "image/png", filename: "chart.png" },
          { type: "image", image: new URL("https://example.org/remote.png") },
        ],
      },
    ]
    const original = JSON.stringify(messages)
    const result = await materializeAttachmentInput(messages, new AbortController().signal)
    expect(deserialize(serialize(result))).toEqual(result)
    expect(JSON.stringify(messages)).toBe(original)
    expect(JSON.stringify(result)).toContain(`data:image/png;base64,${bytes.toString("base64")}`)
    expect(JSON.stringify(result)).toContain(`Show ![chart](${reference})`)
    expect(JSON.stringify(result)).toContain("https://example.org/remote.png")
    expect(await (await Asset.read(id))!.bytes()).toEqual(new Uint8Array(bytes))
  }))

test("inline image representations, assistant files and tool media use the same preparation boundary", () =>
  runtime.run(async () => {
    const base64 = bytes.toString("base64")
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: bytes, providerOptions: { openai: { imageDetail: "high" } } },
          { type: "image", image: new Uint8Array(bytes).buffer },
          { type: "image", image: base64 },
          { type: "image", image: new URL(`data:application/octet-stream;base64,${base64}`) },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "file", data: bytes, mediaType: "image/jpeg", filename: "wrong-extension.jpg" }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "image-1",
            toolName: "browser",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot" },
                { type: "media", data: base64, mediaType: "image/jpeg" },
                { type: "media", data: "AUDIO_DATA", mediaType: "audio/wav" },
              ],
            },
          },
        ],
      },
    ]
    const before = JSON.stringify(messages)
    preparations = 0
    const prepared = await materializeAttachmentInput(messages, new AbortController().signal)
    expect(preparations).toBe(6)
    expect(JSON.stringify(messages)).toBe(before)
    expect(deserialize(serialize(prepared))).toEqual(prepared)
    expect(JSON.stringify(prepared)).toContain('"imageDetail":"high"')
    expect(JSON.stringify(prepared)).not.toContain('"mediaType":"image/jpeg"')
    expect(prepared[2]).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "image-1",
          output: {
            value: [
              { type: "text", text: "Screenshot" },
              { type: "media", data: base64, mediaType: "image/png" },
              { type: "media", data: "AUDIO_DATA", mediaType: "audio/wav" },
            ],
          },
        },
      ],
    })
  }))

test("bad image data is replaced individually without losing text, other images or tool call identity", () =>
  runtime.run(async () => {
    const result = await materializeAttachmentInput(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Keep the conversation" },
            { type: "image", image: "data:image/png;base64,%%%" },
            { type: "image", image: "data:image/png;base64," },
            { type: "image", image: Buffer.from("corrupt image") },
            { type: "file", mediaType: "image/png", data: "data:image/png,not-base64" },
            { type: "image", image: bytes },
            { type: "file", data: "PDF_DATA", mediaType: "application/pdf" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "capture",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Tool result retained" },
                  { type: "media", data: "!!!!", mediaType: "image/png" },
                ],
              },
            },
          ],
        },
      ],
      new AbortController().signal,
    )
    const wire = JSON.stringify(result)
    expect(wire.match(/Image omitted/g)).toHaveLength(5)
    expect(wire).toContain("Keep the conversation")
    expect(wire).toContain(bytes.toString("base64"))
    expect(wire).toContain("PDF_DATA")
    expect(wire).toContain("Tool result retained")
    expect(wire).toContain("call_1")
    expect(wire).not.toContain("!!!!")
  }))

test("a Runtime without an image processor continues with an explicit image placeholder", async () => {
  await using other = await testRuntime()
  await other.run(async () => {
    const result = await materializeAttachmentInput(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Still answer" },
            { type: "image", image: bytes },
          ],
        },
      ],
      new AbortController().signal,
    )
    expect(JSON.stringify(result)).toContain("image processing is unavailable")
    expect(JSON.stringify(result)).toContain("Still answer")
    expect(() => AttachmentImageInput.register(async () => ({ ok: false, reason: "invalid" }))).toThrow()
  })
})

test("invalid, missing and cancelled assets fail before provider dispatch", () =>
  runtime.run(async () => {
    for (const reference of ["asset://../../private.png", "asset://0000000000000000.png"]) {
      await expect(
        materializeAttachmentInput(
          [{ role: "user", content: [{ type: "image", image: reference }] }],
          new AbortController().signal,
        ),
      ).rejects.toThrow()
    }
    const id = await Asset.write(Buffer.from("IMAGE"), "image/png")
    await expect(
      materializeAttachmentInput(
        [{ role: "user", content: [{ type: "image", image: `asset://${id}` }] }],
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled")
  }))
