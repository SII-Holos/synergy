/**
 * Pet mood state machine.
 *
 * Pure logic: it maps Synergy bus events (as delivered over the /global/event
 * SSE stream) to a small set of moods, and applies idle/sleepy degradation and
 * transient mood expiry on tick. It owns no timers and no Electron state, so it
 * is unit-testable without mocks.
 */

export type PetMood = "idle" | "working" | "happy" | "celebrate" | "angry" | "sleepy" | "dragging"

export const PET_MOODS: readonly PetMood[] = ["idle", "working", "happy", "celebrate", "angry", "sleepy", "dragging"]

/** Raw SSE bus event as delivered by GET /global/event. */
export interface PetBusEvent {
  type?: string
  properties?: Record<string, unknown>
}

export interface PetStateMachineOptions {
  /** ms of continuous inactivity before idle degrades to sleepy. */
  idleTimeoutMs: number
  /** ms a happy/angry transient mood stays before returning to idle. */
  transientMs?: number
  now?: () => number
}

export interface PetStateSnapshot {
  mood: PetMood
  activeSessions: string[]
  moodChangedAt: number
  since: number
}

const DEFAULT_TRANSIENT_MS = 4_000

export class PetStateMachine {
  /** ms of continuous inactivity before idle degrades to sleepy. */
  idleTimeoutMs: number
  private readonly transientMs: number
  private readonly now: () => number
  private readonly active = new Map<string, number>()
  private mood: PetMood = "idle"
  private moodChangedAt = 0
  private idleSince = 0
  private transientUntil = 0

  constructor(options: PetStateMachineOptions) {
    this.transientMs = options.transientMs ?? DEFAULT_TRANSIENT_MS
    this.idleTimeoutMs = options.idleTimeoutMs
    this.now = options.now ?? Date.now
    this.moodChangedAt = this.now()
    this.idleSince = this.moodChangedAt
  }

  snapshot(): PetStateSnapshot {
    return {
      mood: this.mood,
      activeSessions: [...this.active.keys()],
      moodChangedAt: this.moodChangedAt,
      since: this.now(),
    }
  }

  /** Process one bus event; returns the mood after processing (may be unchanged). */
  handleEvent(event: PetBusEvent, now = this.now()): PetMood {
    const props = event.properties ?? {}
    switch (event.type) {
      case "session.updated": {
        const info = props.info as { id?: string; working?: unknown; pendingReply?: boolean } | undefined
        const sessionID = info?.id
        if (!sessionID) return this.mood
        if (isBusyInfo(info)) this.markActive(sessionID, now)
        else this.markIdle(sessionID, now)
        break
      }
      case "session.status": {
        const sessionID = props.sessionID as string | undefined
        const status = props.status as { type?: string } | undefined
        if (!sessionID) return this.mood
        if (status?.type === "busy" || status?.type === "retry" || status?.type === "recovering") {
          this.markActive(sessionID, now)
        } else {
          this.markIdle(sessionID, now)
        }
        break
      }
      case "session.completion": {
        this.clearTransient(now)
        this.markIdle((props.sessionID as string | undefined) ?? "", now)
        if (this.active.size === 0 && this.mood !== "celebrate") this.enterTransient("celebrate", now)
        break
      }
      case "session.error": {
        this.clearTransient(now)
        this.markIdle((props.sessionID as string | undefined) ?? "", now)
        if (this.active.size === 0 && this.mood !== "angry") this.enterTransient("angry", now)
        break
      }
      case "session.idle": {
        this.markIdle((props.sessionID as string | undefined) ?? "", now)
        break
      }
    }
    return this.mood
  }

  /** Renderer poke (click); a short happy reaction. */
  poke(now = this.now()): PetMood {
    this.clearTransient(now)
    if (this.active.size === 0 && this.mood !== "happy") this.enterTransient("happy", now)
    return this.mood
  }

  /** Renderer-driven moods; drop returns to the evaluated mood. */
  setDragging(dragging: boolean, now = this.now()): PetMood {
    if (dragging) {
      this.mood = "dragging"
      this.moodChangedAt = now
      return this.mood
    }
    if (this.mood !== "dragging") return this.mood
    return this.recompute(now)
  }

  /** Periodic degradation: expire transient moods and degrade idle to sleepy. */
  tick(now = this.now()): PetMood {
    if (this.mood === "happy" || this.mood === "celebrate" || this.mood === "angry") {
      if (now >= this.transientUntil) {
        this.clearTransient(now)
        return this.recompute(now)
      }
      return this.mood
    }
    return this.recompute(now)
  }

  private markActive(sessionID: string, now: number): void {
    if (!sessionID) return
    this.active.set(sessionID, now)
    if (this.mood === "sleepy" || this.mood === "happy" || this.mood === "celebrate" || this.mood === "angry") {
      this.clearTransient(now)
    }
    if (this.mood !== "working") {
      this.mood = "working"
      this.moodChangedAt = now
    }
  }

  private markIdle(sessionID: string, now: number): void {
    if (!sessionID) return
    if (this.active.delete(sessionID) && this.active.size === 0) {
      this.idleSince = now
      if (this.mood === "working") {
        this.mood = "idle"
        this.moodChangedAt = now
      }
    }
  }

  private enterTransient(mood: "happy" | "celebrate" | "angry", now: number): void {
    this.mood = mood
    this.moodChangedAt = now
    this.transientUntil = now + this.transientMs
    this.idleSince = now
  }

  private clearTransient(now: number): void {
    this.transientUntil = 0
    this.idleSince = now
  }

  private recompute(now: number): PetMood {
    if (this.active.size > 0) {
      this.mood = "working"
      this.moodChangedAt = now
      return this.mood
    }
    if (this.idleSince > 0 && now - this.idleSince >= this.idleTimeoutMs) {
      this.mood = "sleepy"
      this.moodChangedAt = now
      return this.mood
    }
    this.mood = "idle"
    this.moodChangedAt = now
    return this.mood
  }
}

function isBusyInfo(info: { working?: unknown; pendingReply?: boolean }): boolean {
  if (info.pendingReply) return true
  const working = info.working
  if (!working || typeof working !== "object") return false
  return (working as { status?: string }).status === "busy" || (working as { status?: string }).status === "retry"
}
