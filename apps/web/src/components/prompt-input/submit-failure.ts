import { requestErrorMessage } from "@/utils/error"

export type PromptSubmitFailure =
  | { kind: "worktree-unavailable"; message: string }
  | { kind: "workspace-unavailable"; message: string; workspaceID: string; reason?: string }
  | { kind: "generic"; message: string }

function failureBody(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "APIError" || !("data" in error)) return error
  const data = error.data as { statusCode?: number; responseBody?: string }
  if (data.statusCode !== 409 || !data.responseBody) return error
  try {
    return JSON.parse(data.responseBody) as unknown
  } catch {
    return error
  }
}

export function promptSubmitFailure(error: unknown): PromptSubmitFailure {
  const body = failureBody(error)
  if (body && typeof body === "object" && "name" in body) {
    if (body.name === "WorktreeUnavailableError")
      return { kind: "worktree-unavailable", message: requestErrorMessage(body) }
    if (body.name === "WorkspaceUnavailable" && "data" in body && body.data && typeof body.data === "object") {
      const data = body.data
      if ("workspaceID" in data && typeof data.workspaceID === "string")
        return {
          kind: "workspace-unavailable",
          message: requestErrorMessage(body),
          workspaceID: data.workspaceID,
          reason: "reason" in data && typeof data.reason === "string" ? data.reason : undefined,
        }
    }
  }
  return { kind: "generic", message: requestErrorMessage(error) }
}
