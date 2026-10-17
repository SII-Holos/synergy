import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { isBareUrlBoundary } from "@ericsanchezok/synergy-util/markdown-link"
import * as smd from "streaming-markdown"
import { createMarkdownStreamMotion } from "./markdown-stream-motion"
import { createMarkdownStreamSource, type MarkdownStreamLayout } from "./markdown-stream-source"
import { createMarkdownLinkStream } from "./markdown-stream-links"
import type { MarkdownDocument } from "../context/markdown-document"

const allowedProtocols = new Set(["http:", "https:", "mailto:", "tel:"])
const relativeUrlBase = "https://synergy.invalid/"

function isSafeUrl(value: string) {
  try {
    return allowedProtocols.has(new URL(value, relativeUrlBase).protocol)
  } catch {
    return false
  }
}

function createSafeRenderer(
  root: HTMLElement,
  motion: ReturnType<typeof createMarkdownStreamMotion>,
  source: ReturnType<typeof createMarkdownStreamSource>,
): smd.Default_Renderer {
  const renderer = smd.default_renderer(root)
  return {
    ...renderer,
    track_source: true,
    add_token(data, type, start) {
      renderer.add_token(data, type)
      const node = data.nodes[data.index]
      if (type === smd.RAW_URL) node?.setAttribute("data-resource-bare", "pending")
      if (node && start !== undefined && start >= 0) source.token(node, start)
    },
    add_text(data, text, spans) {
      const node = data.nodes[data.index]
      if (node?.nodeName === "IMG") {
        node.setAttribute("alt", (node.getAttribute("alt") ?? "") + text)
        return
      }
      if (!node) return
      let start = 0
      for (const part of motion.append(node, text)) {
        let offset = 0
        for (const segment of spans ?? []) {
          const end = offset + segment.length
          const from = Math.max(start, offset)
          const to = Math.min(start + part.length, end)
          if (from < to && segment.source >= 0)
            source.append(part.node, {
              source: segment.source + from - offset,
              offset: part.offset + from - start,
              length: to - from,
            })
          offset = end
        }
        start += part.length
      }
    },
    set_attr(data, type, value) {
      if (type === smd.HREF || type === smd.SRC) {
        const reference = ResourceReference.parse(value)
        if (type === smd.SRC) {
          data.nodes[data.index]?.setAttribute("data-resource-reference", value)
          if (reference.kind === "image") {
            smd.default_set_attr(data, type, reference.url)
            return
          }
          if (reference.kind !== "url" || !/^https?:/i.test(reference.url)) return
        }
        if (reference.kind !== "url" && reference.kind !== "anchor") {
          const element = data.nodes[data.index]
          element?.setAttribute("data-resource-reference", value)
          if (type === smd.HREF) {
            element?.setAttribute("role", "button")
            element?.setAttribute("tabindex", "0")
          }
          return
        }
        if (reference.kind === "url") value = reference.url
        if (!isSafeUrl(value)) return
      }
      smd.default_set_attr(data, type, value)
      if (type !== smd.HREF) return
      data.nodes[data.index]?.setAttribute("rel", "noopener noreferrer")
      if (data.nodes[data.index]?.getAttribute("data-resource-bare") === "pending")
        data.nodes[data.index]?.setAttribute("data-resource-bare", "true")
    },
  }
}

export interface MarkdownStreamController {
  update(snapshot: string, key?: string): void
  end(): void
  layout(document: MarkdownDocument): MarkdownStreamLayout | undefined
  sourceAt(node: Text, offset: number): number | undefined
}

export function createMarkdownStreamController(root: HTMLElement): MarkdownStreamController {
  let parser!: smd.Parser
  let offset = 0
  let ended = false
  let hasUpdate = false
  let key: string | undefined
  let motion: ReturnType<typeof createMarkdownStreamMotion>
  let source: ReturnType<typeof createMarkdownStreamSource>
  let renderer: ReturnType<typeof createSafeRenderer>
  let links: ReturnType<typeof createMarkdownLinkStream>

  const reset = () => {
    motion?.dispose()
    source = createMarkdownStreamSource(root)
    motion = createMarkdownStreamMotion(root, (from, target, offset) => source.merge(from, target, offset))
    root.replaceChildren()
    renderer = createSafeRenderer(root, motion, source)
    parser = smd.parser(renderer)
    links = createMarkdownLinkStream(parser)
    offset = 0
    ended = false
  }

  reset()

  return {
    update(snapshot, nextKey) {
      const restart = ended || snapshot.length < offset || (hasUpdate && key !== nextKey)
      if (restart) reset()
      motion.begin(hasUpdate && !restart)
      hasUpdate = true
      key = nextKey
      const delta = snapshot.slice(offset)
      const previous = offset ? snapshot[offset - 1] : ""
      offset = snapshot.length
      let from = 0
      for (let index = 0; index < delta.length; index++) {
        if (!isBareUrlBoundary(delta[index])) continue
        links.write(delta.slice(from, index), offset - delta.length + from, from ? delta[from - 1] : previous)
        if (parser.token === smd.RAW_URL) {
          renderer.set_attr(renderer.data, smd.HREF, parser.pending)
          renderer.end_token(renderer.data)
          parser.token = parser.tokens[--parser.len]
          parser.pending = ""
        }
        links.write(delta[index], offset - delta.length + index, index ? delta[index - 1] : previous)
        if (
          parser.pending === delta[index] &&
          ![
            smd.LINK,
            smd.IMAGE,
            smd.CODE_INLINE,
            smd.CODE_BLOCK,
            smd.CODE_FENCE,
            smd.EQUATION_BLOCK,
            smd.EQUATION_INLINE,
          ].some((type) => type === parser.token)
        ) {
          renderer.add_text(renderer.data, parser.pending, [{ source: offset - delta.length + index, length: 1 }])
          parser.pending = ""
        }
        from = index + 1
      }
      links.write(delta.slice(from), offset - delta.length + from, from ? delta[from - 1] : previous)
      motion.play()
    },
    end() {
      if (ended) return
      ended = true
      motion.begin(false)
      try {
        links.end()
        smd.parser_end(parser)
      } catch {
        return
      } finally {
        motion.dispose()
      }
    },
    layout: (document) => source.capture(document),
    sourceAt: (node, offset) => source.sourceAt(node, offset),
  }
}
