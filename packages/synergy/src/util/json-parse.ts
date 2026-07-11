export function parseJson<T = Record<string, unknown>>(text: string | null | undefined): T {
  if (!text) return {} as T
  try {
    const parsed = JSON.parse(text)
    return (parsed && typeof parsed === "object" ? parsed : {}) as T
  } catch {
    return {} as T
  }
}
