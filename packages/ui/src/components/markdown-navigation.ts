export function markdownHeadings(root: ParentNode, counts = new Map<string, number>()) {
  return Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).map((element) => {
    const base = (element.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-")
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    return { element, id: element.id || `${base}${occurrence ? `-${occurrence}` : ""}` }
  })
}

export function focusMarkdownHeading(element: HTMLElement) {
  element.setAttribute("tabindex", "-1")
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: "start", behavior: "instant" })
}

export function revealMarkdownHeading(root: HTMLElement, id: string) {
  const view = root.ownerDocument.defaultView
  if (!view) return false
  const event = new view.CustomEvent("markdown-reveal-heading", { detail: id, cancelable: true })
  if (!root.dispatchEvent(event)) return true
  const heading = markdownHeadings(root).find((item) => item.id === id)
  if (!heading) return false
  focusMarkdownHeading(heading.element)
  return true
}
