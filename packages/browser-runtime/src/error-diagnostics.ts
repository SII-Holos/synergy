import { z } from "zod"

const schemaFields = new Set([
  "pages",
  "page",
  "error",
  "message",
  "code",
  "type",
  "status",
  "profileId",
  "id",
  "url",
  "title",
  "isLoading",
  "lastActiveAt",
  "retryable",
  "pageId",
  "protocolVersion",
  "seq",
  "epoch",
  "version",
  "timestamp",
  "annotations",
  "downloads",
])
const systemCodes = new Set(["EACCES", "EPERM", "ENOSPC", "EIO", "ENOENT", "EROFS", "EMFILE", "ENFILE"])

export function browserErrorDiagnostics(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      errorKind: "schema_validation",
      issueCount: error.issues.length,
      issues: error.issues.slice(0, 8).map((issue) => ({
        code: issue.code,
        path: issue.path
          .slice(0, 8)
          .map((field) =>
            typeof field === "number" ? field : typeof field === "string" && schemaFields.has(field) ? field : "*",
          ),
      })),
    }
  }
  const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined
  if (typeof code === "string" && systemCodes.has(code)) return { errorKind: "system_error", code }
  return {
    errorKind:
      error instanceof TypeError
        ? "type_error"
        : error instanceof RangeError
          ? "range_error"
          : error instanceof Error
            ? "error"
            : "non_error",
  }
}
