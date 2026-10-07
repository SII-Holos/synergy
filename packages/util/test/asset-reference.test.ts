import { describe, expect, test } from "bun:test"
import { AssetReference } from "../src/asset-reference"

describe("managed asset references", () => {
  test("resolves immutable references and MIME without filesystem assumptions", () => {
    expect(AssetReference.parse("asset://0123456789abcdef.docx")).toEqual({
      id: "0123456789abcdef.docx",
      url: "asset://0123456789abcdef.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    expect(AssetReference.parse("asset://0123456789abcdef")).toMatchObject({ mime: "application/octet-stream" })
  })

  test.each([
    "asset://../secrets",
    "asset://0123456789abcdef.png/extra",
    "asset://0123456789abcdef.png?download=1",
    "asset://0123456789abcdef.png#fragment",
    "asset://0123456789abcdef.png%2f..",
    "asset://host/0123456789abcdef.png",
    "https://example.com/0123456789abcdef.png",
    "ASSET://0123456789abcdef.png",
    "asset://0123456789abcdef.png\n",
  ])("rejects noncanonical or unsafe reference %s", (value) => {
    expect(AssetReference.parse(value)).toBeUndefined()
  })
})
