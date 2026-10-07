import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import * as smd from "streaming-markdown"
import { createMarkdownStreamMotion } from "./markdown-stream-motion"
import { createMarkdownStreamSource, type MarkdownStreamLayout } from "./markdown-stream-source"
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
        const reference = AssetReference.parse(value)
        if (reference) {
          data.nodes[data.index]?.setAttribute("data-resource-reference", reference.url)
          return
        }
        if (!isSafeUrl(value)) return
      }
      smd.default_set_attr(data, type, value)
      if (type !== smd.HREF) return
      data.nodes[data.index]?.setAttribute("rel", "noopener noreferrer")
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

  const reset = () => {
    motion?.dispose()
    source = createMarkdownStreamSource(root)
    motion = createMarkdownStreamMotion(root, (from, target, offset) => source.merge(from, target, offset))
    root.replaceChildren()
    renderer = createSafeRenderer(root, motion, source)
    parser = smd.parser(renderer)
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
      offset = snapshot.length
      smd.parser_write(parser, delta)
      motion.play()
    },
    end() {
      if (ended) return
      ended = true
      motion.begin(false)
      try {
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
