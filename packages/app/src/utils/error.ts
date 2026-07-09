export function requestErrorMessage(error: unknown, fallback = "Request failed") {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}
