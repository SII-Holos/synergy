// Provenance: https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/tui/src/streaming/controller.rs
// Local adaptation: keep settled DOM intact and fade only new suffixes; no terminal pacing or source buffering.
export function createMarkdownStreamMotion(root: HTMLElement) {
  const document = root.ownerDocument
  const window = document.defaultView
  const reduced = window?.matchMedia?.("(prefers-reduced-motion: reduce)")
  const pending = new Map<HTMLElement, Animation | undefined>()
  const batch = new Set<HTMLSpanElement>()
  let enabled = false
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const selecting = () => {
    const selection = document.getSelection()
    return (
      !!selection &&
      !selection.isCollapsed &&
      (root.contains(selection.anchorNode) || root.contains(selection.focusNode))
    )
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
    span.replaceWith(...span.childNodes)
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
      if (!enabled) {
        parent.appendChild(document.createTextNode(text))
        return
      }
      // Keep a continued grapheme in its original text run instead of splitting it across opacity spans.
      const previous = parent.lastChild
      const tail = previous?.nodeType === 1 && pending.has(previous as HTMLElement) ? previous.lastChild : previous
      if (tail?.nodeType === 3) {
        const node = tail as Text
        const boundary = node.length
        const segment = graphemes.segment(node.data + text).containing(boundary - 1)
        const joined = segment ? segment.index + segment.segment.length - boundary : 0
        if (joined > 0) {
          node.appendData(text.slice(0, joined))
          text = text.slice(joined)
          if (!text) return
        }
      }
      let span = parent.lastChild as HTMLSpanElement | null
      if (!span || !batch.has(span)) span = null
      if (!span) {
        if (pending.size >= 32) {
          parent.appendChild(document.createTextNode(text))
          return
        }
        span = document.createElement("span")
        span.dataset.streamArrival = ""
        parent.appendChild(span)
        batch.add(span)
        pending.set(span, undefined)
      }
      span.appendChild(document.createTextNode(text))
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
