import { expect, test } from "bun:test"
import { InputImages } from "../../src/session/rollout/input-images"

const data = Buffer.from("exact-image-bytes")
const url = `data:image/png;base64,${data.toString("base64")}`

test("image receipts bind exact bytes after final provider transforms", () => {
  const before = [{ role: "user", content: [{ type: "image", image: data, mediaType: "image/png" }] }]
  expect(InputImages.compare(before, [])).toEqual([
    { sha256: InputImages.digest(data), status: "omitted", reason: "provider_transform_omitted" },
  ])
  expect(InputImages.compare(before, before)).toEqual([{ sha256: InputImages.digest(data), status: "included" }])
})

test("final provider file parts preserve image proof without admitting documents", () => {
  const before = [{ role: "user", content: [{ type: "image", image: data, mediaType: "image/png" }] }]
  const after = [{ role: "user", content: [{ type: "file", data, mediaType: "image/png" }] }]
  expect(InputImages.compare(before, after)).toEqual([{ sha256: InputImages.digest(data), status: "included" }])
  expect(
    InputImages.compare(before, [
      { content: [{ type: "file", data: data.toString("base64"), mediaType: "image/png" }] },
    ]),
  ).toEqual([{ sha256: InputImages.digest(data), status: "included" }])
  expect(InputImages.compare([], [{ content: [{ type: "file", data, mediaType: "application/pdf" }] }])).toEqual([])
})

test("final SDK tool-result image parts carry exact image proof", () => {
  const content = (value: unknown[]) => [
    { role: "tool", content: [{ type: "tool-result", output: { type: "content", value } }] },
  ]
  for (const part of [
    { type: "image-data", data: data.toString("base64"), mediaType: "image/png" },
    { type: "image-url", url },
    { type: "media", data: data.toString("base64"), mediaType: "image/png" },
  ])
    expect(InputImages.compare(content([part]), content([part]))).toEqual([
      { sha256: InputImages.digest(data), status: "included" },
    ])
  expect(InputImages.compare(content([{ type: "text", text: url }]), content([{ type: "text", text: url }]))).toEqual(
    [],
  )
  expect(
    InputImages.compare(
      [],
      [{ content: [{ type: "tool-result", output: { type: "json", value: { type: "image-url", url } } }] }],
    ),
  ).toEqual([])
})

test("wire proof recognizes provider image payloads but never a text mention of an image", () => {
  const hash = InputImages.digest(data)
  for (const part of [
    { type: "image_url", image_url: { url } },
    { type: "input_image", image_url: url },
    { type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } },
    { inlineData: { mimeType: "image/png", data: data.toString("base64") } },
    { image: { format: "png", source: { bytes: data.toString("base64") } } },
  ])
    expect(InputImages.wire(JSON.stringify({ messages: [{ content: [part] }] }))).toEqual([hash])
  expect(InputImages.wire(JSON.stringify({ messages: [{ content: url }] }))).toEqual([])
  expect(InputImages.wire("damaged body")).toEqual([])
})
