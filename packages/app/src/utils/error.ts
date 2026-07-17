export function requestErrorMessage(error: unknown, fallback = "Request failed") {
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string; error?: string } }).data
    if (data?.message) return data.message
    if (data?.error) return data.error
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}
