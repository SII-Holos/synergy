export type PrependAnchorCandidate = {
  messageID: string
  top: number
  bottom: number
}

export type PrependScrollAnchor = {
  messageID: string
  offsetTop: number
}

export function selectPrependAnchor(
  candidates: readonly PrependAnchorCandidate[],
  viewportTop: number,
): PrependScrollAnchor | undefined {
  const anchor = candidates.find((candidate) => candidate.bottom > viewportTop)
  if (!anchor) return
  return {
    messageID: anchor.messageID,
    offsetTop: anchor.top - viewportTop,
  }
}

export function adjustedScrollTop(input: { scrollTop: number; beforeOffsetTop: number; afterOffsetTop: number }) {
  return input.scrollTop + input.afterOffsetTop - input.beforeOffsetTop
}
