function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

interface ErrorEvidence {
  categories: string[]
  codes: string[]
  cause: ErrorEvidence | null
  statusCode?: number
  retryable?: boolean
}

const categories = {
  storage: /checkpoint|persist|storage|sqlite|database/i,
  coordination: /coordination|workspace.?lease|ownership|reservation|write.?conflict|directory.?identity/i,
  permission: /permission|sandbox|denied|not permitted/i,
  process: /process|spawn|signal|exit/i,
  timeout: /timeout|timed.?out|deadline/i,
  cancellation: /abort|cancel|interrupt/i,
  transport: /connection|network|fetch|http|socket/i,
  validation: /schema|validation|parse|invalid.?argument/i,
}
const errorCodes = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "EIO",
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EAGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOENT",
  "EROFS",
  "WORKSPACE_DIRECTORY_IDENTITY_CHANGED",
  "tool_unavailable",
  "permission_denied",
  "unknown_tool",
  "invalid_arguments",
]

function errorEvidence(value: unknown, depth = 0): ErrorEvidence | null {
  if (value === undefined || value === null) return null
  const error = record(value)
  const data = record(error.data)
  const metadata = record(data.metadata)
  const text = [value, error.name, error.message, error.code, data.message, metadata.code]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.slice(0, 8192))
    .join("\n")
  const matched = Object.entries(categories).flatMap(([category, pattern]) => (pattern.test(text) ? [category] : []))
  const statusCode = error.statusCode ?? data.statusCode
  const retryable = error.isRetryable ?? data.isRetryable
  return {
    categories: matched.length ? matched : ["unknown"],
    codes: errorCodes.filter((code) => new RegExp(`\\b${code}\\b`).test(text)),
    cause: depth < 2 ? errorEvidence(error.cause ?? data.cause, depth + 1) : null,
    ...(typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? { statusCode }
      : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  }
}

export function upgradeProtocolEvidence(messages: unknown[]) {
  const retained = messages.slice(-64)
  const positions = new Map(
    retained.flatMap((message, index) => {
      const id = record(record(message).info).id
      return typeof id === "string" ? [[id, index] as const] : []
    }),
  )
  const calls = new Map<string, number>()
  return retained.map((message) => {
    const value = record(message)
    const info = record(value.info)
    const parts = Array.isArray(value.parts) ? value.parts : []
    const parent = typeof info.parentID === "string" ? positions.get(info.parentID) : undefined
    const finish = info.finish
    return {
      role: info.role === "user" || info.role === "assistant" ? info.role : "unknown",
      parent: parent ?? null,
      error: errorEvidence(info.error),
      finish:
        finish === undefined
          ? null
          : typeof finish === "string" && ["stop", "tool-calls", "length", "content-filter", "error"].includes(finish)
            ? finish
            : "unknown",
      tools: parts
        .filter((part) => record(part).type === "tool")
        .slice(0, 32)
        .map((part) => {
          const tool = record(part)
          const state = record(tool.state)
          const status = state.status
          const metadata = record(state.metadata)
          const diagnostic = record(metadata.toolDiagnostic)
          if (typeof tool.callID === "string" && !calls.has(tool.callID)) calls.set(tool.callID, calls.size)
          return {
            call: typeof tool.callID === "string" ? calls.get(tool.callID)! : null,
            callHash:
              typeof tool.callID === "string" ? new Bun.CryptoHasher("sha256").update(tool.callID).digest("hex") : null,
            status:
              typeof status === "string" && ["generating", "pending", "running", "completed", "error"].includes(status)
                ? status
                : "unknown",
            error:
              state.error === undefined && metadata.toolDiagnostic === undefined
                ? null
                : errorEvidence({
                    message: [state.error, diagnostic.message].filter((part) => typeof part === "string").join("\n"),
                    code: diagnostic.code,
                    cause: diagnostic.cause ?? record(diagnostic.metadata).cause,
                  }),
            exit: typeof metadata.exit === "number" && Number.isSafeInteger(metadata.exit) ? metadata.exit : null,
          }
        }),
    }
  })
}
