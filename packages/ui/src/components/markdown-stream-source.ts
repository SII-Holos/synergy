import type { MarkdownDocument } from "../context/markdown-document"
import { markdownScrollViewport } from "./markdown-scroll-viewport"

export type MarkdownLayoutSignature = { width: number; font: string }

export function markdownLayoutSignature(root: HTMLElement): MarkdownLayoutSignature {
  const style = getComputedStyle(root)
  return {
    width: root.clientWidth,
    font: JSON.stringify([
      style.font,
      style.lineHeight,
      style.letterSpacing,
      style.fontFeatureSettings,
      style.fontVariationSettings,
      getComputedStyle(root.ownerDocument.documentElement).fontSize,
      ...[
        "--font-family-mono",
        "--font-family-mono--font-feature-settings",
        "--font-size-small",
        "--line-height-large",
        "--font-weight-medium",
      ].map((token) => style.getPropertyValue(token)),
    ]),
  }
}

export type MarkdownStreamLayout = MarkdownLayoutSignature & {
  sizes: number[]
  anchor?: { index: number; source: number; offset: number }
}

type Segment = { source: number; offset: number; length: number }

export function createMarkdownStreamSource(root: HTMLElement) {
  const nodes = new WeakMap<Text, Segment[]>()
  const tokens = new WeakMap<HTMLElement, number>()
  return {
    token(node: HTMLElement, source: number) {
      tokens.set(node, source)
    },
    append(node: Text, segment: Segment) {
      const segments = nodes.get(node) ?? []
      const previous = segments.at(-1)
      if (
        previous &&
        previous.source + previous.length === segment.source &&
        previous.offset + previous.length === segment.offset
      )
        previous.length += segment.length
      else segments.push(segment)
      nodes.set(node, segments)
    },
    merge(from: Text, target: Text, offset: number) {
      for (const segment of nodes.get(from) ?? []) this.append(target, { ...segment, offset: offset + segment.offset })
      nodes.delete(from)
    },
    sourceAt(node: Text, offset: number) {
      const segment = nodes
        .get(node)
        ?.find((segment) => segment.offset <= offset && offset < segment.offset + segment.length)
      return segment ? segment.source + offset - segment.offset : undefined
    },
    capture(document: MarkdownDocument): MarkdownStreamLayout | undefined {
      const width = root.clientWidth
      if (!width || !document.blocks.length) return
      const positions: Array<{ source: number; node: Text; segment: Segment } | { source: number; node: HTMLElement }> =
        []
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (node.nodeType === Node.TEXT_NODE) {
          for (const segment of nodes.get(node as Text) ?? [])
            positions.push({ source: segment.source, node: node as Text, segment })
        } else {
          const source = tokens.get(node as HTMLElement)
          if (source !== undefined) positions.push({ source, node: node as HTMLElement })
        }
      }
      if (!positions.length) return
      positions.sort((left, right) => left.source - right.source)
      const range = root.ownerDocument.createRange()
      let cursor = 0
      const position = (source: number) => {
        while (cursor + 1 < positions.length && positions[cursor + 1].source <= source) cursor++
        let point = positions[cursor]
        if ("segment" in point && point.source + point.segment.length <= source && positions[cursor + 1])
          point = positions[++cursor]
        if (!("segment" in point)) {
          const walker = root.ownerDocument.createTreeWalker(point.node, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode as Text
            const segment = nodes.get(node)?.[0]
            if (!segment || !node.data.trim()) continue
            point = { source: segment.source, node, segment }
            break
          }
          if (!("segment" in point)) return point.node.getBoundingClientRect().top
        }
        const offset = Math.max(0, Math.min(point.segment.length - 1, source - point.source)) + point.segment.offset
        range.setStart(point.node, offset)
        range.setEnd(point.node, Math.min(point.node.length, offset + 1))
        return range.getBoundingClientRect().top
      }
      const bounds = root.getBoundingClientRect()
      const tops = document.blocks.map((block) => position(block.source.start))
      const sizes = tops.map((top, index) => Math.max(1, (tops[index + 1] ?? bounds.bottom) - top))
      sizes[0] += Math.max(0, tops[0] - bounds.top)
      const scroller = markdownScrollViewport(root)
      const viewportTop = scroller?.getBoundingClientRect().top ?? 0
      const viewportBottom = scroller ? viewportTop + scroller.clientHeight : window.innerHeight
      let reading: { source: number; top: number } | undefined
      for (const point of positions) {
        if (!("segment" in point)) {
          if (!point.node.matches("img, hr")) continue
          const rect = point.node.getBoundingClientRect()
          if (rect.bottom > viewportTop && rect.top < viewportBottom) {
            reading = { source: point.source, top: rect.top }
            break
          }
          continue
        }
        range.setStart(point.node, point.segment.offset)
        range.setEnd(point.node, point.segment.offset + point.segment.length)
        const box = range.getBoundingClientRect()
        if (box.bottom <= viewportTop || box.top >= viewportBottom) continue
        let low = point.segment.offset,
          high = point.segment.offset + point.segment.length - 1
        while (low < high) {
          const middle = (low + high) >>> 1
          range.setStart(point.node, middle)
          range.setEnd(point.node, middle + 1)
          if (range.getBoundingClientRect().bottom > viewportTop) high = middle
          else low = middle + 1
        }
        while (low < point.segment.offset + point.segment.length && /\s/.test(point.node.data[low])) low++
        if (low < point.segment.offset + point.segment.length) {
          range.setStart(point.node, low)
          range.setEnd(
            point.node,
            Math.min(point.node.length, low + (point.node.data.codePointAt(low)! > 0xffff ? 2 : 1)),
          )
          const rect = range.getBoundingClientRect()
          if (rect.top < viewportBottom) reading = { source: point.source + low - point.segment.offset, top: rect.top }
        }
        if (reading) break
      }
      const index = reading
        ? document.blocks.findIndex(
            (block) => block.source.start <= reading.source && reading.source < block.source.end,
          )
        : -1
      return {
        ...markdownLayoutSignature(root),
        sizes,
        anchor: index < 0 ? undefined : { index, source: reading!.source, offset: reading!.top - viewportTop },
      }
    },
  }
}
