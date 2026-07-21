import { BrowserAPIErrorSchema } from "@ericsanchezok/synergy-browser"

export interface BrowserErrorInfo {
  message: string
  code?: string
  retryable: boolean
}

export function normalizeBrowserError(error: unknown, fallback: string): BrowserErrorInfo {
  for (const candidate of errorCandidates(error)) {
    const parsed = BrowserAPIErrorSchema.safeParse(candidate)
    if (parsed.success) {
      return { message: parsed.data.message, code: parsed.data.code, retryable: parsed.data.retryable }
    }
  }
  if (error instanceof Error && error.message) return { message: error.message, retryable: false }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return { message: error.message, retryable: false }
  }
  return { message: fallback, retryable: false }
}

export function toBrowserError(error: unknown, fallback: string): Error & BrowserErrorInfo {
  const info = normalizeBrowserError(error, fallback)
  return Object.assign(new Error(info.message), info)
}

function errorCandidates(error: unknown): unknown[] {
  if (!error || typeof error !== "object") return [error]
  const record = error as Record<string, unknown>
  return [error, record.error, record.body, record.data]
}
