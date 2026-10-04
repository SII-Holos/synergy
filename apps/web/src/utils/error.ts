export function requestErrorMessage(error: unknown, fallback = "Request failed") {
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data
    if (data && typeof data === "object") {
      if ("message" in data && typeof data.message === "string" && data.message) return data.message
      if ("error" in data && typeof data.error === "string" && data.error) return data.error
    }
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string" && message) return message
  }
  return fallback
}
