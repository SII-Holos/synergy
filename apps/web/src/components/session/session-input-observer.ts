export function observeSessionInput<T>(options: {
  read(signal: AbortSignal): Promise<T>
  update(value: T): void | Promise<void>
  unavailable(): void
  intervalMs?: number
}): () => void {
  const controller = new AbortController()
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try {
      const value = await options.read(controller.signal)
      if (active) await options.update(value)
    } catch {
      if (active) options.unavailable()
    } finally {
      if (active) timer = setTimeout(poll, options.intervalMs ?? 2_000)
    }
  }
  void poll()
  return () => {
    active = false
    controller.abort()
    if (timer) clearTimeout(timer)
  }
}
