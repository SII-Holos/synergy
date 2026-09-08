export async function requestWithinLimit(request: Request, maxBytes: number): Promise<boolean> {
  const body = request.clone().body
  if (!body) return true
  const reader = body.getReader()
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) return true
      total += item.value.byteLength
      if (total <= maxBytes) continue
      await reader.cancel().catch(() => {})
      return false
    }
  } finally {
    reader.releaseLock()
  }
}
