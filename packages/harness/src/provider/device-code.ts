export namespace ProviderDeviceCode {
  const DEFAULT_EXPIRY_SECONDS = 900
  const MIN_EXPIRY_SECONDS = 60
  const MAX_EXPIRY_SECONDS = 900
  const REQUEST_TIMEOUT_MS = 15_000

  export function expirySeconds(value: unknown) {
    const parsed = Number(value ?? DEFAULT_EXPIRY_SECONDS)
    if (!Number.isFinite(parsed)) return DEFAULT_EXPIRY_SECONDS
    return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, parsed))
  }

  export async function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await Bun.sleep(ms)
      return true
    }
    if (signal.aborted) return false
    return new Promise((resolve) => {
      const abort = () => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        resolve(false)
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve(true)
      }, ms)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      timeout.unref?.()
    })
  }

  export function requestSignal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }
}
