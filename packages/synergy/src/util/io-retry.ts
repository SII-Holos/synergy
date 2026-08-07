import fs from "fs/promises"

/**
 * Transient filesystem errors that occur when another process briefly holds a
 * file handle (Windows sharing violations, antivirus scans, OneDrive sync).
 * Retrying is safe; a permanent permission or data error must not be masked.
 */
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

export function isRetryableIOError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" && RETRYABLE_CODES.has(code)
}

/**
 * Read a file as UTF-8, retrying transient lock errors (EPERM/EACCES/EBUSY).
 * Non-retryable errors (ENOENT, malformed content) and retry exhaustion
 * propagate so callers keep fail-closed semantics instead of silently
 * treating an unreadable store as empty.
 */
export async function readFileWithRetry(
  file: string,
  options?: { attempts?: number; delayMs?: number },
): Promise<string> {
  const attempts = Math.max(1, options?.attempts ?? 3)
  const delayMs = Math.max(0, options?.delayMs ?? 100)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fs.readFile(file, "utf8")
    } catch (error) {
      lastError = error
      if (!isRetryableIOError(error) || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}
