export function spaceFetch(owner: AbortSignal, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    owner.throwIfAborted()
    const request = new Request(input, init)
    const signal = AbortSignal.any([owner, request.signal])
    signal.throwIfAborted()
    const response = await fetcher(new Request(request, { signal }))
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
    }
    return response
  }
  return Object.assign(transport, { preconnect() {} })
}
