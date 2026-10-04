import type { parse } from "@babel/parser"
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs"
import { parseRenderablePatch } from "@ericsanchezok/synergy-ui/diff-patch-utils"
import type { ReviewContent } from "./review-data"

// Provenance: https://babeljs.io/docs/babel-parser (version 7.28.5 AST contract).
// Local adaptation: fold leading static declarations while retaining the original line positions and source bytes.
export function staticImportLines(text: string, parser: typeof parse) {
  try {
    const body = parser(text, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }).program.body
    if (!body.length || text.slice(0, body[0]!.start ?? 0).trim()) return 0
    let lines = 0
    for (const node of body) {
      if (node.type !== "ImportDeclaration" && node.type !== "TSImportEqualsDeclaration") break
      lines = node.loc?.end.line ?? 0
    }
    return lines
  } catch {
    return 0
  }
}

export function projectReviewMetadata(input: {
  file: string
  content?: ReviewContent
  patch?: string
  whitespace?: boolean
  ignoreWhitespace?: boolean
  imports?: { before: number; after: number }
}): FileDiffMetadata {
  const value = input.content
  let metadata: FileDiffMetadata
  const text = value && [value.before.kind, value.after.kind].every((kind) => kind === "text" || kind === "missing")
  if (text) {
    const before = (value.before.content ?? "")
      .split("\n")
      .slice(input.imports?.before ?? 0)
      .join("\n")
    const after = (value.after.content ?? "")
      .split("\n")
      .slice(input.imports?.after ?? 0)
      .join("\n")
    const normalize = (text: string) => (input.ignoreWhitespace ? text.replace(/[\t \r]+/g, "") : text)
    metadata = parseDiffFromFile(
      value.before.kind === "missing" ? null : { name: input.file, contents: normalize(before) },
      value.after.kind === "missing" ? null : { name: input.file, contents: normalize(after) },
    )
    if (input.ignoreWhitespace)
      metadata = {
        ...metadata,
        deletionLines: before.match(/[^\n]*\n|[^\n]+$/g) ?? [],
        additionLines: after.match(/[^\n]*\n|[^\n]+$/g) ?? [],
      }
    if (input.imports?.before || input.imports?.after) {
      metadata = {
        ...metadata,
        isPartial: true,
        hunks: metadata.hunks.map((hunk, index) => ({
          ...hunk,
          deletionStart: hunk.deletionStart + (input.imports?.before ?? 0),
          additionStart: hunk.additionStart + (input.imports?.after ?? 0),
          collapsedBefore: index === 0 ? 0 : hunk.collapsedBefore,
        })),
      }
    }
  } else
    metadata =
      parseRenderablePatch(value?.diff.patch ?? input.patch ?? "") ??
      parseDiffFromFile({ name: input.file, contents: "" }, { name: input.file, contents: "" })
  if (!input.whitespace) return metadata
  const display = (line: string) => line.replace(/ /g, "·").replace(/\t/g, "→\t")
  return {
    ...metadata,
    additionLines: metadata.additionLines.map(display),
    deletionLines: metadata.deletionLines.map(display),
  }
}
