import { getGeneratedKatexSource } from "../context/markdown-math-source"

const mathSelector = ".katex-display, .katex"

function enclosingMath(node: Node) {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  const math = element?.closest(".katex-display") ?? element?.closest(".katex")
  return math && getGeneratedKatexSource(math) ? math : undefined
}

function rangeText(range: Range) {
  let text = ""
  let breaks = 0
  let verbatim = false
  const separate = (count: number) => {
    breaks = Math.max(breaks, count)
  }
  const append = (value: string, preserve = false) => {
    if (!preserve) value = value.replace(/[\t\r\n\f ]+/g, " ")
    if (!value || (!preserve && breaks && !value.trim())) return
    if (breaks) {
      if (!verbatim) text = text.replace(/ +$/, "")
      if (text) text += "\n".repeat(Math.max(0, breaks - (text.match(/\n*$/)?.[0].length ?? 0)))
      breaks = 0
      if (!preserve) value = value.trimStart()
    }
    if (!preserve && (!text || /[\n\t]$/.test(text))) value = value.trimStart()
    if (!preserve && text.endsWith(" ") && value.startsWith(" ")) value = value.slice(1)
    text += value
    verbatim = preserve
  }
  const visit = (node: Node, preserve = false) => {
    if (!range.intersectsNode(node)) return
    if (node.nodeType === 3) {
      const value = node.textContent ?? ""
      const start = node === range.startContainer ? range.startOffset : 0
      const end = node === range.endContainer ? range.endOffset : value.length
      append(value.slice(start, end), preserve)
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (element.matches('script, style, annotation, button, [hidden], [aria-hidden="true"], [data-selection-excluded]'))
      return
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return
    const source = getGeneratedKatexSource(element)
    if (source) {
      const display = element.classList.contains("katex-display")
      if (display) separate(2)
      append(display ? `$$\n${source}\n$$` : `$${source}$`, true)
      if (display) separate(2)
      return
    }
    const tag = element.tagName.toLowerCase()
    if (tag === "br") {
      breaks += 1
      return
    }
    const boundary = /^(p|h[1-6]|blockquote|pre)$/.test(tag)
      ? 2
      : /^(div|section|article|ul|ol|li|tr)$/.test(tag)
        ? 1
        : 0
    separate(boundary)
    for (const child of element.childNodes) visit(child, preserve || tag === "pre")
    separate(boundary)
    if (
      (tag === "td" || tag === "th") &&
      element.nextElementSibling &&
      range.intersectsNode(element.nextElementSibling)
    )
      append("\t", true)
  }
  const root = range.commonAncestorContainer
  visit(root, !!root.parentElement?.closest("pre"))
  return verbatim ? text : text.trimEnd()
}

// Provenance: https://github.com/KaTeX/KaTeX/blob/main/contrib/copy-tex/copy-tex.ts
// Local adaptation: expand formula endpoints on a cloned range, trust only generated math, and preserve prose boundaries.
export function selectedMathText(selection: Selection | null): string | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0).cloneRange()
  const start = enclosingMath(range.startContainer)
  const end = enclosingMath(range.endContainer)
  if (start) range.setStartBefore(start)
  if (end) range.setEndAfter(end)
  const root = range.commonAncestorContainer
  if (root.nodeType !== 1) return
  if (
    ![...(root as Element).querySelectorAll(mathSelector)].some(
      (element) => range.intersectsNode(element) && getGeneratedKatexSource(element),
    )
  )
    return
  return rangeText(range)
}
