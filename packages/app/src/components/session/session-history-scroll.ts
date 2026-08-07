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

/**
 * Keeps the visible content stable when the top of the timeline is trimmed
 * (turnStart auto-advance). The container shrinks from the top, so the same
 * visual position requires scrollTop to decrease by the removed height.
 * Mirrors `adjustedScrollTop` for the "removal" direction.
 */
export function adjustTrimScrollTop(input: {
  scrollTop: number
  beforeScrollHeight: number
  afterScrollHeight: number
  clientHeight: number
}) {
  const delta = input.afterScrollHeight - input.beforeScrollHeight
  const next = input.scrollTop + delta
  const max = Math.max(0, input.afterScrollHeight - input.clientHeight)
  return Math.min(Math.max(0, next), max)
}

export type TurnTrimInput = {
  visibleRootCount: number
  turnStart: number
  maxRenderedTurns: number
  historyMode: boolean
  scrolledUp: boolean
  userScrolled: boolean
  distanceFromBottom: number
  pinnedThreshold: number
}

export type TurnTrimDecision = { trim: false } | { trim: true; nextTurnStart: number }

/**
 * Decides whether the rendered turn window should advance (trim from the top)
 * to keep the DOM bounded. Only trims while the user is pinned at the bottom
 * of a latest-mode conversation; history, scrolled-up, or user-scrolled states
 * keep the full window so the "Load earlier" path and anchors stay intact.
 */
export function computeTurnTrim(input: TurnTrimInput): TurnTrimDecision {
  const { visibleRootCount: len, turnStart: start, maxRenderedTurns } = input
  if (len <= 0) return { trim: false }
  if (start <= 0) return { trim: false }
  if (len - start <= maxRenderedTurns) return { trim: false }
  if (input.historyMode || input.scrolledUp || input.userScrolled) return { trim: false }
  if (input.distanceFromBottom >= input.pinnedThreshold) return { trim: false }
  return { trim: true, nextTurnStart: len - maxRenderedTurns }
}
