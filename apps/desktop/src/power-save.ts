import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

export const DesktopPowerStateV1 = z
  .object({
    version: z.literal(1),
    keepAwakeWhileRunning: z.boolean(),
  })
  .strict()
export type DesktopPowerStateV1 = z.infer<typeof DesktopPowerStateV1>

export const DesktopPowerUpdate = z.object({ keepAwakeWhileRunning: z.boolean() }).strict()
export type DesktopPowerUpdate = z.infer<typeof DesktopPowerUpdate>

/**
 * Mirrors the server's `/global/activity` payload so a malformed or unexpected
 * response can never be mistaken for real activity.
 */
export const DesktopActivitySchema = z
  .object({
    active: z.boolean(),
    sessions: z.number().int().nonnegative(),
    backgroundJobs: z.number().int().nonnegative(),
  })
  .strict()
export type DesktopActivity = z.infer<typeof DesktopActivitySchema>

export type DesktopPowerSnapshot = { keepAwakeWhileRunning: boolean; active: boolean }

export type DesktopPowerEvent = { type: "power"; snapshot: DesktopPowerSnapshot }

const DESKTOP_POWER_FILE = "desktop-power.json"

export const DEFAULT_DESKTOP_POWER_STATE: DesktopPowerStateV1 = { version: 1, keepAwakeWhileRunning: false }

export const ACTIVITY_POLL_MS = 5000
export const ACTIVITY_FAILURE_GRACE_MS = 15000
export const RELEASE_DEBOUNCE_MS = 5000

export function desktopPowerFilePath(userDataPath: string): string {
  return path.join(userDataPath, DESKTOP_POWER_FILE)
}

export function defaultDesktopPowerState(): DesktopPowerStateV1 {
  return { ...DEFAULT_DESKTOP_POWER_STATE }
}

export async function loadDesktopPower(userDataPath: string): Promise<DesktopPowerStateV1> {
  try {
    const content = await readFile(desktopPowerFilePath(userDataPath), "utf8")
    const parsed = DesktopPowerStateV1.safeParse(JSON.parse(content))
    if (parsed.success) return parsed.data
  } catch {
    // Missing or unreadable state falls back to keep-awake disabled.
  }
  return defaultDesktopPowerState()
}

export async function saveDesktopPower(userDataPath: string, state: DesktopPowerStateV1): Promise<void> {
  const filepath = desktopPowerFilePath(userDataPath)
  await mkdir(path.dirname(filepath), { recursive: true })
  await writeFile(filepath, `${JSON.stringify(state, null, 2)}\n`)
}

export function parseDesktopPowerUpdate(input: unknown): DesktopPowerUpdate {
  return DesktopPowerUpdate.parse(input)
}

export function parseDesktopActivity(input: unknown): DesktopActivity {
  return DesktopActivitySchema.parse(input)
}

export interface PowerSaveBlockerLike {
  start(type: "prevent-app-suspension"): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface DesktopPowerGuard {
  apply(desired: boolean): void
  release(): void
  active(): boolean
}

/**
 * Sole owner of the operating-system power assertion. Idempotent, and treats
 * the blocker's own `isStarted` report as truth so an assertion the system
 * dropped (for example across suspend/resume) is re-acquired on the next
 * apply. `prevent-app-suspension` keeps the machine awake while still letting
 * the display turn off.
 */
export function createDesktopPowerGuard(blocker: PowerSaveBlockerLike): DesktopPowerGuard {
  let blockerId: number | null = null

  function started(): boolean {
    return blockerId !== null && blocker.isStarted(blockerId)
  }

  return {
    apply(desired: boolean) {
      if (!desired) {
        if (blockerId !== null) {
          blocker.stop(blockerId)
          blockerId = null
        }
        return
      }
      if (started()) return
      blockerId = blocker.start("prevent-app-suspension")
    },
    release() {
      if (blockerId !== null) {
        blocker.stop(blockerId)
        blockerId = null
      }
    },
    active() {
      return started()
    },
  }
}

export interface DesktopActivityWatcherOptions {
  intervalMs: number
  requestTimeoutMs?: number
  failureGraceMs: number
  releaseDebounceMs: number
  /** Current server origin, re-read every poll so a restarted server is picked up. */
  resolveBaseUrl: () => string | null
  fetchActivity: (url: string, signal: AbortSignal) => Promise<unknown>
  onDesiredChange: (desired: boolean) => void
  onError: (error: unknown) => void
}

export interface DesktopActivityWatcher {
  start(): void
  stop(): void
  recheck(): void
}

/**
 * Polls the server's authoritative activity endpoint and reports one desired
 * assertion state. Rising edges apply immediately; falling edges wait out a
 * debounce so the gap between turns does not flap the assertion. Repeated
 * transport failures keep the last known state until the grace window expires.
 */
export function createDesktopActivityWatcher(options: DesktopActivityWatcherOptions): DesktopActivityWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null
  let releaseTimer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let running = false
  let generation = 0
  let inFlight = false
  let recheckRequested = false
  let desired = false
  let failureStartedAt: number | null = null
  const now = () => Date.now()

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function clearReleaseTimer() {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
  }

  function emit(next: boolean) {
    if (next === desired) return
    desired = next
    options.onDesiredChange(next)
  }

  function applyActive() {
    clearReleaseTimer()
    failureStartedAt = null
    emit(true)
  }

  function applyInactive() {
    failureStartedAt = null
    if (!desired) {
      clearReleaseTimer()
      return
    }
    if (releaseTimer !== null) return
    releaseTimer = setTimeout(() => {
      releaseTimer = null
      emit(false)
    }, options.releaseDebounceMs)
  }

  function applyFailure(error: unknown) {
    options.onError(error)
    const startedAt = failureStartedAt ?? now()
    failureStartedAt = startedAt
    if (now() - startedAt >= options.failureGraceMs) applyInactive()
  }

  function schedule() {
    clearTimer()
    if (!running) return
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, options.intervalMs)
  }

  async function poll() {
    if (!running || inFlight) return
    const baseUrl = options.resolveBaseUrl()
    if (!baseUrl) {
      applyInactive()
      schedule()
      return
    }
    inFlight = true
    const pollGeneration = generation
    const request = new AbortController()
    controller = request
    const deadline = setTimeout(
      () => request.abort(new Error("Activity request timed out")),
      options.requestTimeoutMs ?? ACTIVITY_POLL_MS,
    )
    try {
      const activity = parseDesktopActivity(await options.fetchActivity(`${baseUrl}/global/activity`, request.signal))
      if (!running || pollGeneration !== generation) return
      if (activity.active) applyActive()
      else applyInactive()
    } catch (error) {
      if (!running || pollGeneration !== generation) return
      applyFailure(error)
    } finally {
      clearTimeout(deadline)
      if (pollGeneration === generation) {
        inFlight = false
        if (controller === request) controller = null
        schedule()
        if (recheckRequested) {
          recheckRequested = false
          void poll()
        }
      }
    }
  }

  return {
    start() {
      if (running) return
      generation++
      running = true
      void poll()
    },
    stop() {
      if (!running) return
      generation++
      running = false
      recheckRequested = false
      clearTimer()
      clearReleaseTimer()
      controller?.abort()
      controller = null
      inFlight = false
      failureStartedAt = null
      if (desired) {
        desired = false
        options.onDesiredChange(false)
      }
    },
    recheck() {
      if (!running) return
      if (desired) options.onDesiredChange(true)
      if (inFlight) {
        recheckRequested = true
        return
      }
      clearTimer()
      void poll()
    },
  }
}
