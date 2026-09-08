import { requestErrorMessage } from "@/utils/error"

export type PromptSubmitFailure =
  | { kind: "worktree-unavailable"; message: string }
  | { kind: "generic"; message: string }

function worktreeUnavailableMessage(error: unknown) {
  if (!error || typeof error !== "object") return
  if ("name" in error && error.name === "WorktreeUnavailableError") return requestErrorMessage(error)
  if (!(error instanceof Error) || error.name !== "APIError" || !("data" in error)) return

  const data = error.data as { statusCode?: number; responseBody?: string }
  if (data.statusCode !== 409 || !data.responseBody) return
  try {
    const body = JSON.parse(data.responseBody) as { name?: string; data?: { message?: string } }
    if (body.name !== "WorktreeUnavailableError" || !body.data?.message) return
    return body.data.message
  } catch {
    return
  }
}

export function promptSubmitFailure(error: unknown): PromptSubmitFailure {
  const worktreeMessage = worktreeUnavailableMessage(error)
  if (worktreeMessage) return { kind: "worktree-unavailable", message: worktreeMessage }
  return { kind: "generic", message: requestErrorMessage(error) }
}
