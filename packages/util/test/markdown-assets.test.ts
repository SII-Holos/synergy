import { expect, test } from "bun:test"
import { markdownAssetReferences, markdownAssetReferencesComplete } from "../src/markdown-assets"

const image = "asset://0123456789abcdef.png"
const document = "asset://fedcba9876543210.docx"

test("collects only rendered managed Markdown references", () => {
  expect(markdownAssetReferences(`[page](${document}#page=2)`)).toEqual([document])
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

test("complete dependency traversal keeps rendered references beyond display budgets and preserves Markdown semantics", () => {
  const refs = Array.from({ length: 80 }, (_, index) => `asset://${index.toString(16).padStart(16, "0")}.png`)
  const source =
    "paragraph ".repeat(40000) +
    "\n\n" +
    refs.map((url) => `![chart](${url})`).join("\n") +
    `\n\n[late][source]\n\n[source]: ${document}\n\n\`![example](${image})\`\n\n\`\`\`md\n![hidden](${image})\n\`\`\``
  expect([...markdownAssetReferencesComplete(source)]).toEqual([...refs, document])
  expect(markdownAssetReferences(source)).toEqual([])
  expect([
    ...markdownAssetReferencesComplete(
      `| cell |\n| --- |\n| ![image](${image}) |\n\n- [document](${document})\n\n![again](${image})`,
    ),
  ]).toEqual([image, document, image])
})
