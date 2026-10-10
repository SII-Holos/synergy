export type ConversationReadingPosition = {
  messageID: string
  partID?: string
  anchor?: string
  block?: number
  offset: number
}

export function captureConversationReadingPosition(container: HTMLElement): ConversationReadingPosition | undefined {
  const top = container.getBoundingClientRect().top
  const bottom = container.getBoundingClientRect().bottom
  const visible = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > top && rect.top < bottom && !node.closest("[hidden]")
  }
  const paragraphs = [...container.querySelectorAll<HTMLElement>("p,li,pre,h1,h2,h3,h4,h5,h6")].filter(visible)
  const node =
    paragraphs.find((node) => node.getBoundingClientRect().top >= top) ??
    paragraphs[0] ??
    [...container.querySelectorAll<HTMLElement>("[data-scroll-anchor],[data-part-id],[data-message-id]")].find(visible)
  const message = node?.closest<HTMLElement>("[data-message-id]")
  if (!node || !message?.dataset.messageId) return
  const part = node.closest<HTMLElement>("[data-part-id]")
  const anchor = node.closest<HTMLElement>("[data-scroll-anchor]")
  const owner = part ?? anchor ?? message
  const blocks = [...owner.querySelectorAll<HTMLElement>("p,li,pre,h1,h2,h3,h4,h5,h6")]
  const block = blocks.indexOf(node)
  return {
    messageID: message.dataset.messageId,
    partID: part?.dataset.partId,
    anchor: anchor?.dataset.scrollAnchor,
    block: block >= 0 ? block : undefined,
    offset: node.getBoundingClientRect().top - top,
  }
}

export function restoreConversationReadingPosition(
  container: HTMLElement,
  position: ConversationReadingPosition,
  requireBlock = false,
) {
  const messages = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].filter(
    (node) => node.dataset.messageId === position.messageID,
  )
  const part = position.partID
    ? messages
        .flatMap((node) => [node, ...node.querySelectorAll<HTMLElement>("[data-part-id]")])
        .find((node) => node.dataset.partId === position.partID)
    : undefined
  const anchor = position.anchor
    ? messages
        .flatMap((node) => [node, ...node.querySelectorAll<HTMLElement>("[data-scroll-anchor]")])
        .find((node) => node.dataset.scrollAnchor === position.anchor)
    : undefined
  const message =
    messages.find((node) => node.dataset.rowKind === "body" || node.querySelector("p,li,pre,h1,h2,h3,h4,h5,h6")) ??
    messages[0]
  if (!message) return false
  const owner = part ?? anchor ?? message
  const block =
    position.block === undefined
      ? undefined
      : owner.querySelectorAll<HTMLElement>("p,li,pre,h1,h2,h3,h4,h5,h6")[position.block]
  if (requireBlock && position.block !== undefined && (!block || block.getBoundingClientRect().height === 0))
    return false
  const node = block ?? owner
  container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset
  return true
}

export function captureConversationReadingAnchor(container: HTMLElement, isCurrent: () => boolean, target?: Element) {
  if (!isCurrent() || !container.isConnected || (target && !container.contains(target))) return
  const viewport = container.getBoundingClientRect()
  const viewportTop = viewport.top
  const visible = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > viewportTop && rect.top < viewport.bottom && !node.closest("[hidden]")
  }
  const message = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(visible)
  const row =
    target?.closest<HTMLElement>('[data-component="process-window"]') ??
    target?.closest<HTMLElement>("[data-scroll-anchor]") ??
    target?.closest<HTMLElement>("[data-display-row]") ??
    Array.from((message ?? container).querySelectorAll<HTMLElement>("[data-scroll-anchor]")).find(visible) ??
    message
  if (!row || !container.contains(row) || !visible(row)) return
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
