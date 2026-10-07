import { expect, test } from "bun:test"
import { markdownAssetReferences } from "../src/markdown-assets"

const image = "asset://0123456789abcdef.png"
const document = "asset://fedcba9876543210.docx"

test("collects only rendered managed Markdown references", () => {
  expect(markdownAssetReferences(`![chart](${image})\n[Word][report]\n\n[report]: ${document}`)).toEqual([
    image,
    document,
  ])
  expect(
    markdownAssetReferences(
      `\`${image}\` \`![chart](${image})\`\n\n\`\`\`md\n![chart](${image})\n\`\`\`\n\n${document}`,
    ),
  ).toEqual([])
  expect(markdownAssetReferences(`![in progress](${image}`)).toEqual([])
  expect(
    markdownAssetReferences(`![bad](asset://../secret) [site](https://example.org) ![a](${image}) ![b](${image})`),
  ).toEqual([image])
})

test("bounds summary references and parsing without truncating resource identity", () => {
  const refs = Array.from({ length: 40 }, (_, index) => `asset://${index.toString(16).padStart(16, "0")}.png`)
  expect(markdownAssetReferences(refs.map((url) => `![chart](${url})`).join("\n"))).toEqual(refs.slice(0, 32))
  expect(markdownAssetReferences("x".repeat(262144) + `\n![chart](${image})`)).toEqual([])
})
