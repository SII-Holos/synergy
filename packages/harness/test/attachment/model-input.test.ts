import { afterAll, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { serialize, deserialize } from "node:v8"
import { Asset } from "../../src/asset/asset"
import { materializeAttachmentInput } from "../../src/attachment/model-input"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("asset references become provider bytes only in the transient model request", () =>
  runtime.run(async () => {
    const bytes = Buffer.from("PROVIDER_IMAGE_BYTES")
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
  }))

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
