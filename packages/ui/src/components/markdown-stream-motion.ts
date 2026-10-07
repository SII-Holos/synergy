// Provenance: https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/tui/src/streaming/controller.rs
// Local adaptation: keep settled DOM intact and fade only new suffixes; no terminal pacing or source buffering.
export function createMarkdownStreamMotion(
  root: HTMLElement,
  merge: (from: Text, target: Text, offset: number) => void,
) {
  const document = root.ownerDocument
  const window = document.defaultView
  const reduced = window?.matchMedia?.("(prefers-reduced-motion: reduce)")
  const pending = new Map<HTMLElement, Animation | undefined>()
  const batch = new Set<HTMLSpanElement>()
  let enabled = false
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const tails = new WeakMap<Text, string>()
  const rememberTail = (node: Text, text: string) => {
    if (!root.animate) return
    const suffix = (tails.get(node) ?? "") + text
    tails.set(node, graphemes.segment(suffix).containing(suffix.length - 1)?.segment ?? "")
  }
  const selecting = () => {
    const selection = document.getSelection()
    return (
      !!selection &&
      !selection.isCollapsed &&
      (root.contains(selection.anchorNode) || root.contains(selection.focusNode))
    )
  }
  const preservePoints = (
    translate: (node: Node, offset: number) => { node: Node; offset: number } | undefined,
    mutate: () => void,
  ) => {
    const selection = document.getSelection()
    const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => {
      const range = selection!.getRangeAt(index)
      return {
        range,
        start: translate(range.startContainer, range.startOffset),
        end: translate(range.endContainer, range.endOffset),
      }
    })
    mutate()
    for (const { range, start, end } of ranges) {
      if (start) range.setStart(start.node, start.offset)
      if (end) range.setEnd(end.node, end.offset)
    }
  }
  const mergeText = (target: Text, from: Text) => {
    const offset = target.length
    preservePoints(
      (node, position) => (node === from ? { node: target, offset: offset + position } : undefined),
      () => {
        rememberTail(target, from.data)
        target.appendData(from.data)
        merge(from, target, offset)
        tails.delete(from)
        from.remove()
      },
    )
  }
  const appendText = (parent: HTMLElement, text: string) => {
    const previous = parent.lastChild
    if (previous?.nodeType === 3) {
      const node = previous as Text
      const offset = node.length
      rememberTail(node, text)
      node.appendData(text)
      return { node, offset, length: text.length }
    }
    const node = document.createTextNode(text)
    rememberTail(node, text)
    parent.appendChild(node)
    return { node, offset: 0, length: text.length }
  }
  const settle = (span: HTMLElement, force = false) => {
    const animation = pending.get(span)
    if (animation) {
      animation.onfinish = null
      animation.cancel()
    }
    if (!force && selecting()) {
      pending.set(span, undefined)
      return
    }
    const children = [...span.childNodes]
    preservePoints(
      (node, offset) => {
        if (node === span) {
          const child = children[Math.min(offset, children.length - 1)]
          return child
            ? { node: child, offset: offset < children.length ? 0 : (child.textContent?.length ?? 0) }
            : undefined
        }
        return span.contains(node) ? { node, offset } : undefined
      },
      () => span.replaceWith(...children),
    )
    for (const child of children) {
      if (child.nodeType !== 3 || !child.parentNode) continue
      let node = child as Text
      const previous = node.previousSibling
      if (previous?.nodeType === 3) {
        mergeText(previous as Text, node)
        node = previous as Text
      }
      const next = node.nextSibling
      if (next?.nodeType === 3) mergeText(node, next as Text)
    }
    pending.delete(span)
  }
  const finish = () => {
    for (const span of pending.keys()) settle(span)
  }
  const preferenceChanged = () => {
    if (reduced?.matches) finish()
  }
  const selectionChanged = () => {
    if (selecting()) finish()
    else for (const [span, animation] of pending) if (!animation) settle(span)
  }
  const visibilityChanged = () => {
    if (document.hidden) finish()
  }
  reduced?.addEventListener?.("change", preferenceChanged)
  document.addEventListener("selectionchange", selectionChanged)
  document.addEventListener("visibilitychange", visibilityChanged)
  return {
    begin(animate: boolean) {
      batch.clear()
      enabled = animate && !reduced?.matches && !document.hidden && !selecting() && !!root.animate
    },
    append(parent: HTMLElement, text: string) {
      const appended: Array<{ node: Text; offset: number; length: number }> = []
      if (!enabled) return [appendText(parent, text)]
      // Keep a continued grapheme in its original text run instead of splitting it across opacity spans.
      const previous = parent.lastChild
      const tail = previous?.nodeType === 1 && pending.has(previous as HTMLElement) ? previous.lastChild : previous
      if (tail?.nodeType === 3) {
        const node = tail as Text
        const boundary = (tails.get(node) ?? "").length
        const segment = graphemes.segment((tails.get(node) ?? "") + text).containing(boundary - 1)
        const joined = segment ? segment.index + segment.segment.length - boundary : 0
        if (joined > 0) {
          const offset = node.length
          rememberTail(node, text.slice(0, joined))
          node.appendData(text.slice(0, joined))
          appended.push({ node, offset, length: joined })
          text = text.slice(joined)
          if (!text) return appended
        }
      }
      let span = parent.lastChild as HTMLSpanElement | null
      if (!span || !batch.has(span)) span = null
      if (!span) {
        if (pending.size >= 32) {
          appended.push(appendText(parent, text))
          return appended
        }
        span = document.createElement("span")
        span.dataset.streamArrival = ""
        parent.appendChild(span)
        batch.add(span)
        pending.set(span, undefined)
      }
      appended.push(appendText(span, text))
      return appended
    },
    play() {
      if (!batch.size) return
      const value = window?.getComputedStyle(root).getPropertyValue("--motion-duration-slow").trim()
      const duration = value ? parseFloat(value) * (value.endsWith("ms") ? 1 : 1000) : 240
      for (const span of batch) {
        const animation = span.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration, easing: "ease-out" })
        pending.set(span, animation)
        animation.onfinish = () => {
          if (pending.get(span) === animation) settle(span)
        }
      }
      batch.clear()
    },
    dispose() {
      for (const span of pending.keys()) settle(span, true)
      reduced?.removeEventListener?.("change", preferenceChanged)
      document.removeEventListener("selectionchange", selectionChanged)
      document.removeEventListener("visibilitychange", visibilityChanged)
    },
  }
}
