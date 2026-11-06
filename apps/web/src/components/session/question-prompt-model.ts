import { z } from "zod"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"

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
export const QuestionDraftSchema = z.object({
  step: z.number().int().nonnegative(),
  selections: z.array(z.array(z.string())),
  custom: z.array(z.string()),
  source: z.array(z.enum(["option", "custom"])),
})
export type QuestionDraft = z.infer<typeof QuestionDraftSchema>

export function decisionIdentity(input: {
  serverURL: string
  scopeID: string
  sessionID: string
  requestID: string
  kind: "question" | "permission"
}) {
  return JSON.stringify([input.serverURL, input.scopeID, input.sessionID, input.requestID, input.kind])
}

export function sanitizeQuestionDraft(request: QuestionRequest, value?: unknown): QuestionDraft {
  const parsed = QuestionDraftSchema.safeParse(value)
  const draft = parsed.success ? parsed.data : undefined
  return {
    step: Math.min(draft?.step ?? 0, Math.max(0, request.questions.length - 1)),
    selections: request.questions.map((question, index) => {
      const selected = [...new Set(draft?.selections[index] ?? [])].filter((label) =>
        question.options.some((option) => option.label === label),
      )
      return question.multiple ? selected : selected.slice(0, 1)
    }),
    custom: request.questions.map((_, index) => draft?.custom[index] ?? ""),
    source: request.questions.map((_, index) => draft?.source[index] ?? "option"),
  }
}

export function questionAnswers(request: QuestionRequest, draft: QuestionDraft): string[][] {
  return request.questions.map((question, index) => {
    const custom = draft.custom[index]?.trim()
    const selected = draft.selections[index] ?? []
    if (!question.multiple) return draft.source[index] === "custom" ? (custom ? [custom] : []) : selected.slice(0, 1)
    return [...new Set([...selected, ...(custom ? [custom] : [])])]
  })
}
