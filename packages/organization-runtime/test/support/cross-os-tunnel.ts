type TunnelCallbacks = {
  line(value: string): void
  ready: { resolve(value: string): void; reject(error: Error): void }
  selected?(value: string): void
  eof?(): void
  settled?(): void
}

export async function readCrossOSTunnelStderr(stderr: ReadableStream<Uint8Array>, callbacks: TunnelCallbacks) {
  const stream = stderr.getReader(),
    decoder = new TextDecoder()
  let buffered = ""
  let partialLine = ""
  let publicOrigin: string | undefined
  let registered = false
  try {
    while (true) {
      const result = await stream.read()
      if (result.done) break
      const chunk = decoder.decode(result.value, { stream: true })
      buffered = (buffered + chunk).slice(-32768)
      const lines = (partialLine + chunk).split(/\r?\n/)
      partialLine = lines.pop()!.slice(-32768)
      for (const line of lines) {
        const observed = line.slice(-32768)
        callbacks.line(observed)
        if (observed.includes("Registered tunnel connection")) registered = true
      }
      const previousOrigin = publicOrigin
      publicOrigin ??= buffered.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
      if (previousOrigin === undefined && publicOrigin) callbacks.selected?.(publicOrigin)
      if (publicOrigin && registered) callbacks.ready.resolve(publicOrigin)
    }
    if (partialLine) callbacks.line(partialLine)
    callbacks.eof?.()
    callbacks.ready.reject(new Error("The task-owned tunnel exited before a public HTTPS endpoint was ready"))
  } finally {
    stream.releaseLock()
    callbacks.settled?.()
  }
}

type TunnelEvent = {
  kind: "launched" | "selected" | "banner" | "stderr-eof" | "reader-settled" | "child-exit" | "listener-ready"
  observedAtMs: number
  exitCode?: number
}
export type CrossOSCleanupOwner = "tunnel" | "origin-listener" | "service" | "darwin-peer"
type CleanupEvent = {
  owner: CrossOSCleanupOwner
  phase: "started" | "completed" | "failed"
  observedAtMs: number
}

export function createCrossOSTunnelObservation() {
  const events: TunnelEvent[] = [],
    cleanupEvents: CleanupEvent[] = [],
    hostnames = new Set<string>()
  let eventOverflow = 0,
    cleanupOverflow = 0,
    hostnameOverflow = false,
    selectedOrigin: string | undefined,
    bannerOrigin: string | undefined,
    listenerPortMatchesTunnel: boolean | undefined
  function event(kind: TunnelEvent["kind"], exitCode?: number) {
    if (events.length === 16) {
      eventOverflow++
      return
    }
    events.push({ kind, observedAtMs: performance.now(), ...(exitCode === undefined ? {} : { exitCode }) })
  }
  function boundedOrigin(value: string) {
    return value.length <= 512 && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value) ? value : undefined
  }
  function hostname(origin: string) {
    const value = boundedOrigin(origin)
    if (!value || hostnames.has(value)) return
    if (hostnames.size === 4) hostnameOverflow = true
    else hostnames.add(value)
  }
  return {
    launched() {
      event("launched")
    },
    line(value: string) {
      for (const match of value.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)) hostname(match[0])
      if (bannerOrigin !== undefined) return
      const banner = value.match(/\|\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s*\|/)?.[1]
      if (banner && boundedOrigin(banner)) {
        bannerOrigin = banner
        event("banner")
      }
    },
    selected(origin: string) {
      selectedOrigin = boundedOrigin(origin)
      hostname(origin)
      event("selected")
    },
    eof() {
      event("stderr-eof")
    },
    settled() {
      event("reader-settled")
    },
    exited(exitCode: number) {
      event("child-exit", exitCode)
    },
    listener(actualPort: number | undefined, originalPort: number) {
      listenerPortMatchesTunnel = actualPort === originalPort
      event("listener-ready")
    },
    cleanup(owner: CrossOSCleanupOwner, phase: CleanupEvent["phase"]) {
      if (cleanupEvents.length === 8) cleanupOverflow++
      else cleanupEvents.push({ owner, phase, observedAtMs: performance.now() })
    },
    snapshot() {
      return {
        observedAtMs: performance.now(),
        events: events.map((value) => ({ ...value })),
        eventOverflow,
        cleanupEvents: cleanupEvents.map((value) => ({ ...value })),
        cleanupOverflow,
        retainedDistinctHostnames: hostnames.size,
        hostnameOverflow,
        ...(selectedOrigin === undefined || bannerOrigin === undefined
          ? {}
          : { selectedMatchesObservedBanner: selectedOrigin === bannerOrigin }),
        ...(listenerPortMatchesTunnel === undefined ? {} : { listenerPortMatchesTunnel }),
      }
    },
  }
}
