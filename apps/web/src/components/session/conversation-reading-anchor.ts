export function captureConversationReadingAnchor(container: HTMLElement, isCurrent: () => boolean) {
  const viewportTop = container.getBoundingClientRect().top
  const visible = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > viewportTop && !node.closest("[hidden]")
  }
  const message = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(visible)
  const row =
    Array.from((message ?? container).querySelectorAll<HTMLElement>("[data-scroll-anchor]")).find(visible) ?? message
  if (!row) return
  const rowBounds = row.getBoundingClientRect()
  const block = Array.from(row.querySelectorAll<HTMLElement>("p,li,pre,h1,h2,h3,h4,h5,h6")).find((node) => {
    const rect = node.getBoundingClientRect()
    return visible(node) && rect.top >= rowBounds.top && rect.bottom <= rowBounds.bottom
  })
  const turn = row.closest("[data-component='session-turn']")
  const process = turn?.querySelector<HTMLElement>("[data-slot='turn-process-trigger']")
  const fallbacks = [...new Set([block, row, process].filter((node): node is HTMLElement => !!node))].map((node) => ({
    node,
    offset: node.getBoundingClientRect().top - viewportTop,
  }))
  return () => {
    if (!isCurrent() || !container.isConnected) return
    const anchor = fallbacks.find(
      ({ node }) => node.isConnected && node.getBoundingClientRect().height > 0 && !node.closest("[hidden]"),
    )
    if (!anchor) return
    const displacement = anchor.node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
    if (Math.abs(displacement) > 0.5) container.scrollTop += displacement
  }
}
