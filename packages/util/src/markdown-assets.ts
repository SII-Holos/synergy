import { Marked } from "marked"
import { ResourceReference } from "./resource-reference"

const markdown = new Marked()

export function markdownAssetReferences(text: string): string[] {
  const source = text.slice(0, 262144)
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
