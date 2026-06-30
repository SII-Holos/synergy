import { createRenderEffect, createSignal, onCleanup } from "solid-js"

const EMIT_INTERVAL_MS = 16
const MAX_ELAPSED_MS = 80
const BASE_STREAM_RATE_CPS = 260
const MAX_STREAM_RATE_CPS = 420
const COMPLETION_DRAIN_RATE_CPS = 420
const LOW_BUFFER_CHARS = 80

export interface TypewriterOptions {
  source: () => string
  streaming: () => boolean
  completed?: () => boolean
}

export interface TypewriterFrameState {
  revealedLength: number
  fractional: number
}

export interface TypewriterFrameInput {
  state: TypewriterFrameState
  sourceLength: number
  elapsedMs: number
  streaming: boolean
  completed: boolean
}

function displayRate(buffer: number, streaming: boolean, completed: boolean) {
  if (completed || !streaming) return COMPLETION_DRAIN_RATE_CPS
  if (buffer <= LOW_BUFFER_CHARS) return BASE_STREAM_RATE_CPS

  const overflow = buffer - LOW_BUFFER_CHARS
  const ramp = Math.min(overflow / LOW_BUFFER_CHARS, 1)
  return BASE_STREAM_RATE_CPS + (MAX_STREAM_RATE_CPS - BASE_STREAM_RATE_CPS) * ramp
}

export function advanceTypewriterFrame(input: TypewriterFrameInput): TypewriterFrameState {
  if (input.sourceLength < input.state.revealedLength) {
    return { revealedLength: input.sourceLength, fractional: 0 }
  }

  const buffer = input.sourceLength - input.state.revealedLength
  const rate = displayRate(buffer, input.streaming, input.completed)
  const fractional = input.state.fractional + (rate * Math.min(input.elapsedMs, MAX_ELAPSED_MS)) / 1000
  const chars = Math.floor(fractional)

  if (chars <= 0) return { ...input.state, fractional }

  return {
    revealedLength: Math.min(input.state.revealedLength + chars, input.sourceLength),
    fractional: fractional - chars,
  }
}

/**
 * Creates a bounded backlog smoother for streaming text snapshots.
 */
export function createTypewriter(options: TypewriterOptions) {
  const initialSource = options.source()
  const initialStreaming = options.streaming()
  const initialCompleted = options.completed?.() ?? false
  const initialDisplayed = initialCompleted || !initialStreaming ? initialSource : ""
  const [displayed, setDisplayed] = createSignal(initialDisplayed)
  let rafId: number | undefined
  let animating = false
  let revealedLength = initialDisplayed.length
  let fractional = 0
  let lastTickTime = 0
  let lastEmitTime = 0
  let observedSourceLength = initialSource.length
  let initialized = false
  let live = false

  function stop() {
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId)
      rafId = undefined
    }
    animating = false
    fractional = 0
  }

  function snapTo(source: string) {
    stop()
    revealedLength = source.length
    fractional = 0
    setDisplayed(source)
  }

  function isDone(streaming: boolean, completed: boolean) {
    return completed || !streaming
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
      if (isDone(options.streaming(), options.completed?.() ?? false)) live = false
      return
    }

    const elapsedMs = Math.min(now - lastTickTime, MAX_ELAPSED_MS)
    lastTickTime = now

    const next = advanceTypewriterFrame({
      state: { revealedLength, fractional },
      sourceLength: total,
      elapsedMs,
      streaming: options.streaming(),
      completed: options.completed?.() ?? false,
    })
    revealedLength = next.revealedLength
    fractional = next.fractional

    if (now - lastEmitTime >= EMIT_INTERVAL_MS || revealedLength >= total) {
      lastEmitTime = now
      setDisplayed(source.slice(0, revealedLength))
    }

    if (revealedLength < total) {
      rafId = requestAnimationFrame(tick)
    } else {
      animating = false
      fractional = 0
      if (isDone(options.streaming(), options.completed?.() ?? false)) live = false
    }
  }

  function start() {
    if (animating) return
    animating = true
    lastTickTime = performance.now()
    fractional = 0
    rafId = requestAnimationFrame(tick)
  }

  createRenderEffect(() => {
    const source = options.source()
    const streaming = options.streaming()
    const completed = options.completed?.() ?? false

    if (!initialized) {
      initialized = true
      observedSourceLength = source.length
      if (isDone(streaming, completed)) {
        snapTo(source)
        return
      }

      live = true
      if (source.length > revealedLength) start()
      return
    }

    if (source.length < observedSourceLength) {
      observedSourceLength = source.length
      live = streaming && !completed
      snapTo(source)
      return
    }

    if (source.length > observedSourceLength) observedSourceLength = source.length

    if (source.length > revealedLength) {
      if (streaming && !completed) live = true
      if (!streaming && !completed && !live) {
        snapTo(source)
        return
      }
      start()
      return
    }

    if (!streaming && source.length === revealedLength) live = false

    if (isDone(streaming, completed) && !animating && !live) {
      snapTo(source)
    }
  })

  onCleanup(stop)

  return displayed
}
