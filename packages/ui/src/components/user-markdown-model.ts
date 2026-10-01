import { fromMarkdown } from "mdast-util-from-markdown"
import { gfm } from "micromark-extension-gfm"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { math } from "micromark-extension-math"
import { mathFromMarkdown } from "mdast-util-math"
import { toHast } from "mdast-util-to-hast"
import { toHtml } from "hast-util-to-html"
import { decodeString } from "micromark-util-decode-string"
import type { Nodes, Text } from "mdast"

export interface UserMarkdownReference {
  start: number
  end: number
}

export function userMarkdownImageUrl(value: string) {
  return /^(https?:\/\/|blob:|data:image\/|asset:\/\/|\/asset\/)/i.test(value) ? value : undefined
}

export async function renderUserMarkdown(
  source: string,
  references: UserMarkdownReference[],
  renderBlock?: (source: string, inline?: boolean) => Promise<string>,
) {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  const sorted = references
    .map((reference, index) => ({ ...reference, index }))
    .filter(
      (ref) =>
        Number.isInteger(ref.start) &&
        Number.isInteger(ref.end) &&
        ref.start >= 0 &&
        ref.end > ref.start &&
        ref.end <= source.length,
    )
    .sort((a, b) => a.start - b.start)
  const refs: typeof sorted = []
  for (const ref of sorted) if (ref.start >= (refs.at(-1)?.end ?? 0)) refs.push(ref)
  const blocks = new Map<number, string>()
  const pending: Promise<void>[] = []
  const visit = (node: Nodes, protectedText = false): Nodes[] => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (renderBlock && start !== undefined && end !== undefined && ["code", "math", "inlineMath"].includes(node.type)) {
      pending.push(
        renderBlock(source.slice(start, end), node.type === "inlineMath").then((html) => {
          blocks.set(start, html)
        }),
      )
    }
    if (node.type === "text" && !protectedText && start !== undefined && end !== undefined) {
      const contained = refs.filter((ref) => ref.start >= start && ref.end <= end)
      if (contained.length && decodeString(source.slice(start, end)) === node.value) {
        const children: Text[] = []
        let cursor = start
        for (const ref of contained) {
          if (ref.start > cursor) children.push({ type: "text", value: decodeString(source.slice(cursor, ref.start)) })
          children.push({
            type: "text",
            value: source.slice(ref.start, ref.end),
            data: {
              hName: "button",
              hProperties: { type: "button", "data-user-reference": String(ref.index) },
            },
          })
          cursor = ref.end
        }
        if (cursor < end) children.push({ type: "text", value: decodeString(source.slice(cursor, end)) })
        return children
      }
    }
    if ("children" in node) {
      node.children = node.children.flatMap((child) =>
        visit(child, protectedText || node.type === "link" || node.type === "linkReference"),
      ) as typeof node.children
    }
    return [node]
  }
  visit(tree)
  await Promise.all(pending)
  const block = (node: Nodes) => {
    const html = blocks.get(node.position?.start.offset ?? -1)
    return html === undefined ? undefined : { type: "raw" as const, value: html }
  }
  const hast = toHast(tree, {
    handlers: {
      html: (_state, node) => ({ type: "text", value: node.value }),
      image: (_state, node) => {
        const url = userMarkdownImageUrl(node.url)
        return url
          ? {
              type: "element",
              tagName: "button",
              properties: { type: "button", "data-user-image": url },
              children: [{ type: "text", value: node.alt || node.url }],
            }
          : { type: "text", value: node.alt || node.url }
      },
      imageReference: (state, node) => {
        const definition = state.definitionById.get(node.identifier.toUpperCase())
        const url = userMarkdownImageUrl(definition?.url ?? "")
        return url
          ? {
              type: "element",
              tagName: "button",
              properties: { type: "button", "data-user-image": url },
              children: [{ type: "text", value: node.alt || url }],
            }
          : { type: "text", value: node.alt || source.slice(node.position?.start.offset, node.position?.end.offset) }
      },
      code: (_state, node) =>
        block(node) ?? {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [
            { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: node.value }] },
          ],
        },
      math: (_state, node) =>
        block(node as Nodes) ?? {
          type: "text",
          value: source.slice(node.position?.start.offset, node.position?.end.offset),
        },
      inlineMath: (_state, node) =>
        block(node as Nodes) ?? {
          type: "text",
          value: source.slice(node.position?.start.offset, node.position?.end.offset),
        },
    },
  })
  return toHtml(hast!, { allowDangerousHtml: true })
}
