import { fromMarkdown } from "mdast-util-from-markdown"
import { gfm } from "micromark-extension-gfm"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { math } from "micromark-extension-math"
import { mathFromMarkdown } from "mdast-util-math"
import { toHast } from "mdast-util-to-hast"
import { toHtml } from "hast-util-to-html"
import { decodeString } from "micromark-util-decode-string"
import type { Nodes, Text } from "mdast"
import type { Properties } from "hast"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { isBareUrlBoundary } from "@ericsanchezok/synergy-util/markdown-link"

type MarkdownConstruct = Exclude<NonNullable<NonNullable<ReturnType<typeof gfm>["text"]>[number]>, unknown[]>

function boundedGfm() {
  const extension = gfm()
  const bound = (construct: MarkdownConstruct): MarkdownConstruct => ({
    ...construct,
    previous(code) {
      return (
        construct.previous?.call(
          this,
          code !== null && code > 0 && isBareUrlBoundary(String.fromCodePoint(code)) ? null : code,
        ) ?? true
      )
    },
    tokenize(effects, ok, nok) {
      let completed = false
      const success: typeof ok = (code) => {
        completed = true
        return ok(code)
      }
      const failure: typeof nok = (code) => {
        completed = true
        return nok(code)
      }
      const wrap = (value: Parameters<typeof effects.attempt>[0]): Parameters<typeof effects.attempt>[0] => {
        if (Array.isArray(value)) return value.map(bound)
        if (typeof value.tokenize === "function") return bound(value as MarkdownConstruct)
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            item && (Array.isArray(item) ? item.map(bound) : bound(item)),
          ]),
        )
      }
      const scoped = {
        ...effects,
        attempt: (
          value: Parameters<typeof effects.attempt>[0],
          success: Parameters<typeof effects.attempt>[1],
          failure: Parameters<typeof effects.attempt>[2],
        ) => effects.attempt(wrap(value), success, failure),
        check: (
          value: Parameters<typeof effects.check>[0],
          success: Parameters<typeof effects.check>[1],
          failure: Parameters<typeof effects.check>[2],
        ) => effects.check(wrap(value), success, failure),
      }
      type State = ReturnType<MarkdownConstruct["tokenize"]>
      const state =
        (step: State): State =>
        (code) => {
          const next = step(code !== null && code > 0 && isBareUrlBoundary(String.fromCodePoint(code)) ? null : code)
          return next && !completed ? state(next) : next
        }
      const previous = this.previous
      if (previous !== null && previous > 0 && isBareUrlBoundary(String.fromCodePoint(previous))) this.previous = null
      const initial = construct.tokenize.call(this, scoped, success, failure)
      const start = initial
      return state((code) => {
        try {
          return start(code)
        } finally {
          this.previous = previous
        }
      })
    },
  })
  if (extension.text)
    for (const key of Object.keys(extension.text)) {
      const constructs = extension.text[Number(key)]
      if (Array.isArray(constructs))
        extension.text[Number(key)] = constructs.map((construct) =>
          /^(protocol|www)Autolink$/.test(construct.name ?? "") ? bound(construct) : construct,
        )
    }
  return extension
}

export interface UserMarkdownReference {
  start: number
  end: number
}

export function userMarkdownImageUrl(value: string) {
  const target = ResourceReference.parse(value)
  return ["workspace-file", "asset", "image"].includes(target.kind) ||
    (target.kind === "url" && /^https?:/i.test(target.url))
    ? value
    : undefined
}

function linkProperties(value: string, title?: string | null, bare = false): Properties {
  const target = ResourceReference.parse(value)
  return {
    ...(title ? { title } : {}),
    ...(bare ? { "data-resource-bare": "true" } : {}),
    ...(target.kind === "url"
      ? { href: target.url, target: "_blank", rel: "noopener noreferrer" }
      : target.kind === "anchor"
        ? { href: `#${encodeURIComponent(target.id)}` }
        : { "data-resource-reference": value, role: "button", tabIndex: 0 }),
  }
}

export async function renderUserMarkdown(
  source: string,
  references: UserMarkdownReference[],
  renderBlock?: (source: string, inline?: boolean) => Promise<string>,
) {
  const tree = fromMarkdown(source, {
    extensions: [boundedGfm(), math()],
    mdastExtensions: [
      gfmFromMarkdown().map((extension) =>
        extension.enter?.literalAutolink ? { ...extension, transforms: [] } : extension,
      ),
      mathFromMarkdown(),
    ],
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
        renderBlock(source.slice(start, end), node.type === "inlineMath")
          .then((html) => {
            blocks.set(start, html)
          })
          .catch(() => {}),
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
      link: (state, node) => ({
        type: "element",
        tagName: "a",
        properties: linkProperties(
          node.url,
          node.title,
          /^(?:https?:\/\/|www\.)/i.test(source.slice(node.position?.start.offset, node.position?.end.offset)),
        ),
        children: state.all(node),
      }),
      linkReference: (state, node) => {
        const definition = state.definitionById.get(node.identifier.toUpperCase())
        return definition
          ? {
              type: "element",
              tagName: "a",
              properties: linkProperties(definition.url, definition.title),
              children: state.all(node),
            }
          : { type: "text", value: source.slice(node.position?.start.offset, node.position?.end.offset) }
      },
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
