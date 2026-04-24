import { createEffect, createSignal, onCleanup } from "solid-js"

const MAX_RATE = 280
const MIN_RATE = 18
const DRAIN_RATE = 360
const EMIT_INTERVAL_MS = 16
const MAX_ELAPSED_MS = 100
const INGRESS_SMOOTHING_MS = 260
const INGRESS_DECAY_MS = 640
const TARGET_LOOKAHEAD_MS = 340
const MIN_TARGET_BUFFER = 16
const MAX_TARGET_BUFFER = 80
const GRACE_WINDOW_MS = 220
const GRACE_RATE_FLOOR = 0.55
const RATE_SMOOTHING_MS = 180
const KP = 0.35
const KI = 0.08
const MAX_INTEGRAL = 400

export interface TypewriterOptions {
  source: () => string
  streaming: () => boolean
  completed?: () => boolean
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function smoothingAlpha(elapsedMs: number, tauMs: number) {
  return 1 - Math.exp(-elapsedMs / tauMs)
}

/**
 * Creates an adaptive typewriter effect for streaming text.
 *
 * The controller combines:
 * - an exponentially smoothed ingress-rate estimate
 * - a target buffer sized from that ingress rate
 * - a PI controller that keeps the visible buffer near the target
 * - a short grace window that avoids chunk-to-chunk pulsing
 * - a smoothed output rate so visual speed changes stay gradual
 */
export function createTypewriter(options: TypewriterOptions) {
  const [displayed, setDisplayed] = createSignal("")
  let rafId: number | undefined
  let animating = false
  let revealedLength = 0
  let fractional = 0
  let lastTickTime = 0
  let lastEmitTime = 0
  let ingressRate = 0
  let displayRate = MIN_RATE
  let integralError = 0
  let lastObservedSourceLength = 0
  let lastSourceUpdateTime = 0

  function stop() {
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId)
      rafId = undefined
    }
    animating = false
    fractional = 0
  }

  function resetEstimator(now: number, sourceLength: number) {
    ingressRate = 0
    displayRate = MIN_RATE
    integralError = 0
    lastObservedSourceLength = sourceLength
    lastSourceUpdateTime = now
  }

  function observeSourceGrowth(now: number, sourceLength: number) {
    if (lastSourceUpdateTime === 0 || sourceLength <= lastObservedSourceLength) {
      lastObservedSourceLength = sourceLength
      lastSourceUpdateTime = now
      return
    }

    const deltaChars = sourceLength - lastObservedSourceLength
    const deltaMs = Math.max(1, now - lastSourceUpdateTime)
    const measuredRate = (deltaChars * 1000) / deltaMs
    const alpha = smoothingAlpha(deltaMs, INGRESS_SMOOTHING_MS)

    ingressRate = ingressRate === 0 ? measuredRate : ingressRate + (measuredRate - ingressRate) * alpha
    lastObservedSourceLength = sourceLength
    lastSourceUpdateTime = now
  }

  function decayIngressRate(now: number, elapsedMs: number) {
    const silenceMs = now - lastSourceUpdateTime
    if (silenceMs <= GRACE_WINDOW_MS || ingressRate === 0) return

    const alpha = smoothingAlpha(elapsedMs, INGRESS_DECAY_MS)
    ingressRate += (0 - ingressRate) * alpha
  }

  function getTargetBuffer() {
    return clamp((ingressRate * TARGET_LOOKAHEAD_MS) / 1000, MIN_TARGET_BUFFER, MAX_TARGET_BUFFER)
  }

  function getTargetDisplayRate(
    now: number,
    elapsedMs: number,
    buffer: number,
    streaming: boolean,
    completed: boolean,
  ) {
    if (completed || !streaming) {
      integralError = 0
      return Math.max(DRAIN_RATE, buffer * 10)
    }

    decayIngressRate(now, elapsedMs)

    const targetBuffer = getTargetBuffer()
    const lookaheadSeconds = TARGET_LOOKAHEAD_MS / 1000
    const inGraceWindow = now - lastSourceUpdateTime <= GRACE_WINDOW_MS
    const bufferError = inGraceWindow ? Math.max(buffer - targetBuffer, 0) : buffer - targetBuffer
    const errorRate = bufferError / lookaheadSeconds
    const elapsedSeconds = elapsedMs / 1000

    integralError = clamp(integralError + errorRate * elapsedSeconds, -MAX_INTEGRAL, MAX_INTEGRAL)

    const floor = inGraceWindow ? Math.max(MIN_RATE, ingressRate * GRACE_RATE_FLOOR) : MIN_RATE
    const correction = KP * errorRate + KI * integralError
    return clamp(ingressRate + correction, floor, MAX_RATE)
  }

  function updateDisplayRate(now: number, elapsedMs: number, buffer: number, streaming: boolean, completed: boolean) {
    const targetRate = getTargetDisplayRate(now, elapsedMs, buffer, streaming, completed)
    const alpha = smoothingAlpha(elapsedMs, RATE_SMOOTHING_MS)
    displayRate += (targetRate - displayRate) * alpha
    displayRate = clamp(displayRate, MIN_RATE, MAX_RATE)
    return displayRate
  }

  function tick(now: number) {
    rafId = undefined
    const source = options.source()
    const total = source.length

    if (revealedLength >= total) {
      if (displayed() !== source.slice(0, revealedLength)) {
        setDisplayed(source.slice(0, revealedLength))
      }
      animating = false
      fractional = 0
      integralError = 0
      return
    }

    const elapsedMs = Math.min(now - lastTickTime, MAX_ELAPSED_MS)
    lastTickTime = now

    const buffer = total - revealedLength
    const rate = updateDisplayRate(now, elapsedMs, buffer, options.streaming(), options.completed?.() ?? false)

    fractional += (rate * elapsedMs) / 1000
    const chars = Math.floor(fractional)
    if (chars > 0) {
      fractional -= chars
      revealedLength = Math.min(revealedLength + chars, total)
    }

    if (now - lastEmitTime >= EMIT_INTERVAL_MS || revealedLength >= total) {
      lastEmitTime = now
      setDisplayed(source.slice(0, revealedLength))
    }

    if (revealedLength < total) {
      rafId = requestAnimationFrame(tick)
    } else {
      animating = false
      fractional = 0
      integralError = 0
    }
  }

  function start() {
    if (animating) return
    animating = true
    lastTickTime = performance.now()
    fractional = 0
    rafId = requestAnimationFrame(tick)
  }

  createEffect(() => {
    const source = options.source()
    const streaming = options.streaming()
    const completed = options.completed?.() ?? false
    const now = performance.now()

    if (lastSourceUpdateTime === 0) {
      lastSourceUpdateTime = now
      lastObservedSourceLength = source.length
    }

    if (completed || (!streaming && !animating)) {
      stop()
      revealedLength = source.length
      fractional = 0
      resetEstimator(now, source.length)
      setDisplayed(source)
      return
    }

    if (source.length > lastObservedSourceLength) {
      observeSourceGrowth(now, source.length)
    } else if (source.length < lastObservedSourceLength) {
      resetEstimator(now, source.length)
    }

    if (source.length > revealedLength) {
      start()
    } else if (source.length < revealedLength) {
      stop()
      revealedLength = source.length
      resetEstimator(now, source.length)
      setDisplayed(source)
    }
  })

  onCleanup(stop)

  return displayed
}
