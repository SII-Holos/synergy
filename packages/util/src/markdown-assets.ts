import { Marked, type Token } from "marked"
import { ResourceReference } from "./resource-reference"

const markdown = new Marked()
export const MARKDOWN_ASSET_REFERENCE_CHARS = 262144

export function markdownAssetReferences(text: string): string[] {
  const source = text.slice(0, MARKDOWN_ASSET_REFERENCE_CHARS)
  if (!source.includes("asset://")) return []
  const references = new Set<string>()
  markdown.walkTokens(markdown.lexer(source), (token) => {
    if (references.size >= 32 || (token.type !== "image" && token.type !== "link")) return
    if (token.href.length > 256) return
    const reference = ResourceReference.parse(token.href)
    if (reference.kind === "asset") references.add(reference.url)
  })
  return [...references]
}

export function* markdownAssetReferencesComplete(text: string): Generator<string> {
  if (!text.includes("asset://")) return
  function* references(tokens: readonly Token[]): Generator<string> {
    for (const token of tokens) {
      if (token.type === "image" || token.type === "link") {
        const reference = ResourceReference.parse(token.href)
        if (reference.kind === "asset") yield reference.url
      }
      if (token.type === "table") {
        for (const cell of token.header) yield* references(cell.tokens)
        for (const row of token.rows) for (const cell of row) yield* references(cell.tokens)
      } else if (token.type === "list") {
        for (const item of token.items) yield* references(item.tokens)
      } else if ("tokens" in token && token.tokens) yield* references(token.tokens)
    }
  }
  yield* references(markdown.lexer(text))
}

export function attachmentSuppression(
  outputs: readonly { id: string; references?: readonly string[] }[],
  inline: readonly string[],
): Record<string, string[]> {
  const seen = new Set(inline)
  return Object.fromEntries(
    outputs.map((output) => {
      const hidden = [...new Set(output.references?.filter((reference) => seen.has(reference)))]
      for (const reference of output.references ?? []) seen.add(reference)
      return [output.id, hidden]
    }),
  )
}
