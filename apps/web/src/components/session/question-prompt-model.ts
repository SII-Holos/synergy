export function questionOptionShortcutIndex(input: {
  key: string
  optionCount: number
  scopeActive: boolean
  modified?: boolean
  editable?: boolean
}) {
  if (!input.scopeActive || input.modified || input.editable || !/^[1-9]$/.test(input.key)) return
  const index = Number(input.key) - 1
  if (index >= input.optionCount) return
  return index
}

export interface QuestionCountdown {
  seconds: number
  startedAt: number
}

/**
 * Derives the countdown window for an open question from server-owned request
 * state. The anchor is `createdAt` — when the ask was raised — never the time
 * the card mounted, because a countdown measures elapsed time since the request
 * and a remount (collapse/expand, session switch) must not restart it. A
 * non-positive window is not a countdown, matching the tool-card helper.
 */
export function questionCountdown(request: { timeout?: number; createdAt?: number }): QuestionCountdown | undefined {
  const seconds = request.timeout
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const startedAt = request.createdAt
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined
  return { seconds, startedAt }
}
