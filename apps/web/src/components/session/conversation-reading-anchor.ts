export function captureConversationReadingAnchor(container: HTMLElement, isCurrent: () => boolean, target?: Element) {
  if (!isCurrent() || !container.isConnected || (target && !container.contains(target))) return
  const viewportTop = container.getBoundingClientRect().top
  const visible = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > viewportTop && !node.closest("[hidden]")
  }
  const message = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(visible)
  const row =
    target?.closest<HTMLElement>('[data-component="process-window"]') ??
    target?.closest<HTMLElement>("[data-scroll-anchor]") ??
    target?.closest<HTMLElement>("[data-display-row]") ??
    Array.from((message ?? container).querySelectorAll<HTMLElement>("[data-scroll-anchor]")).find(visible) ??
    message
  if (!row || !container.contains(row)) return
  const rowBounds = row.getBoundingClientRect()
  const block =
    !target &&
    Array.from(row.querySelectorAll<HTMLElement>("[data-reasoning-part],p,li,pre,h1,h2,h3,h4,h5,h6")).find((node) => {
      const rect = node.getBoundingClientRect()
      return visible(node) && rect.top >= rowBounds.top && rect.bottom <= rowBounds.bottom
    })
  const turn = row.closest("[data-component='session-turn']")
  const process = turn?.querySelector<HTMLElement>("[data-slot='turn-process-trigger']")
  const fallbacks = [...new Set([block || undefined, row, process].filter((node): node is HTMLElement => !!node))].map(
    (node) => ({
      node,
      offset: node.getBoundingClientRect().top - viewportTop,
    }),
  )
  return {
    owner: row,
    restore() {
      if (!isCurrent() || !container.isConnected) return
      for (let index = fallbacks.length - 1; index >= 0; index--) {
        const node = fallbacks[index]!.node
        if (!node.isConnected || !container.contains(node)) fallbacks.splice(index, 1)
      }
      const anchor = fallbacks.find(
        ({ node }) => node.isConnected && node.getBoundingClientRect().height > 0 && !node.closest("[hidden]"),
      )
      if (!anchor) return
      const displacement =
        anchor.node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
      if (Math.abs(displacement) > 0.5) container.scrollTop += displacement
    },
  }
}
