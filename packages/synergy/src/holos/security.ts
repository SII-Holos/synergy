const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function validateHolosEndpoint(raw: string, kind: "api" | "ws"): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid Holos ${kind} URL`)
  }

  const expected = kind === "api" ? ["https:", "http:"] : ["wss:", "ws:"]
  if (!expected.includes(url.protocol)) throw new Error(`Invalid Holos ${kind} URL scheme`)
  if (!url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error(`Invalid Holos ${kind} URL structure`)
  }
  if ((url.protocol === "http:" || url.protocol === "ws:") && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Insecure Holos ${kind} endpoint is only allowed on loopback`)
  }
  return url
}

export function secureHolosRequest(input: {
  url: string
  kind: "api" | "ws"
  fetch?: typeof fetch
  init?: RequestInit
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<Response> {
  const parsedUrl = validateHolosEndpoint(input.url, input.kind)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
  let removeAbortListener: (() => void) | undefined
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort(input.signal.reason)
    } else {
      const onAbort = () => controller.abort(input.signal!.reason)
      input.signal.addEventListener("abort", onAbort, { once: true })
      removeAbortListener = () => input.signal!.removeEventListener("abort", onAbort)
    }
  }
  const fetchPromise = new Promise<Response>((resolve, reject) => {
    try {
      resolve((input.fetch ?? fetch)(parsedUrl, { ...input.init, redirect: "error", signal: controller.signal }))
    } catch (err) {
      reject(err)
    }
  })
  return fetchPromise.finally(() => {
    clearTimeout(timeout)
    if (removeAbortListener) removeAbortListener()
  })
}

export function secureHolosFetch(input: {
  url: string
  kind: "api" | "ws"
  secret: string
  fetch?: typeof fetch
  init?: RequestInit
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<Response> {
  const headers = new Headers(input.init?.headers)
  headers.set("Authorization", `Bearer ${input.secret}`)
  return secureHolosRequest({
    url: input.url,
    kind: input.kind,
    fetch: input.fetch,
    init: { ...input.init, headers },
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
}

export const NATIVE_REQUEST_TIMEOUT_MIN_MS = 1_000
export const NATIVE_REQUEST_TIMEOUT_MAX_MS = 120_000

export function clampNativeRequestTimeout(defaultMs: number, raw?: number): number {
  const clamped = Math.min(Math.max(raw ?? defaultMs, NATIVE_REQUEST_TIMEOUT_MIN_MS), NATIVE_REQUEST_TIMEOUT_MAX_MS)
  return clamped
}
