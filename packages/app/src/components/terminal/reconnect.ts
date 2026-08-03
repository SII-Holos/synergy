/**
 * ReconnectController - bounded WebSocket reconnect state machine.
 *
 * The old inline logic reset the failure counter on every `open` event, so any
 * accept-then-immediately-drop cycle (server killed the PTY between upgrade
 * and open, process exit race, etc.) bypassed MAX_RECONNECT_ATTEMPTS forever:
 * the panel showed "Reconnecting..." indefinitely.
 *
 * Rules:
 * - A connection that stays open for at least `quickCycleMs` counts as stable;
 *   dropping a stable connection resets the failure counter and backoff.
 * - Accept-then-drop cycles ("quick cycles") accumulate `maxAttempts` failures,
 *   then give up exactly once.
 * - `onOpen` cancels any pending reconnect timer (a live socket supersedes a
 *   scheduled retry), and a reconnect that completes while a socket is already
 *   up does not create a duplicate connection.
 * - A close arriving while the PTY validation is in flight is not dropped: the
 *   retry is re-scheduled once validation settles.
 * - `dispose()`/`isDisposed()` and PTY validation failures stop the loop
 *   immediately.
 */

export interface ReconnectTimer {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
  now(): number
}

export interface ReconnectControllerOptions {
  /** Quick-cycle failures allowed before giving up. */
  maxAttempts: number
  /** A connection held at least this long counts as stable and resets failures. */
  quickCycleMs: number
  initialDelayMs: number
  maxDelayMs: number
  timer: ReconnectTimer
  /** Called before each reconnect; return false (or throw) to give up. */
  validate: () => Promise<boolean>
  /** Establish a fresh connection. */
  connect: () => void
  /** Connection opened. */
  onConnected: () => void
  /**
   * Called exactly once when the controller gives up.
   * - "missing": the PTY was confirmed gone (validate returned false/threw).
   *   The owning panel may close the tab and release the server session.
   * - "exhausted": retries ran out while the PTY still validated. The process
   *   may still be running; only the presentation should be marked lost.
   */
  onGiveUp: (reason: GiveUpReason) => void
  /** True once the owning component is disposed. */
  isDisposed: () => boolean
}

export type GiveUpReason = "missing" | "exhausted"

export class ReconnectController {
  readonly #opts: ReconnectControllerOptions
  #attempts = 0
  #delayMs: number
  #connectedAt: number | undefined
  #timerId: number | undefined
  #running = false
  #closeWhileRunning = false
  #givenUp = false
  #disposed = false

  constructor(opts: ReconnectControllerOptions) {
    this.#opts = opts
    this.#delayMs = opts.initialDelayMs
  }

  onOpen(): void {
    if (this.#disposed || this.#givenUp) return
    this.#connectedAt = this.#opts.timer.now()
    if (this.#timerId !== undefined) {
      this.#opts.timer.clearTimeout(this.#timerId)
      this.#timerId = undefined
    }
    this.#opts.onConnected()
  }

  onClose(): void {
    if (this.#disposed || this.#givenUp || this.#opts.isDisposed()) return
    const now = this.#opts.timer.now()
    const stable = this.#connectedAt !== undefined && now - this.#connectedAt >= this.#opts.quickCycleMs
    this.#connectedAt = undefined
    if (stable) {
      this.#attempts = 0
      this.#delayMs = this.#opts.initialDelayMs
    } else {
      this.#attempts++
    }
    if (this.#attempts > this.#opts.maxAttempts) {
      this.#giveUp("exhausted")
      return
    }
    if (this.#running) {
      this.#closeWhileRunning = true
      return
    }
    this.#schedule()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#timerId !== undefined) {
      this.#opts.timer.clearTimeout(this.#timerId)
      this.#timerId = undefined
    }
  }

  #schedule(): void {
    if (this.#disposed || this.#timerId !== undefined) return
    const delay = this.#delayMs
    this.#delayMs = Math.min(this.#delayMs * 2, this.#opts.maxDelayMs)
    this.#timerId = this.#opts.timer.setTimeout(() => {
      this.#timerId = undefined
      void this.#reconnect()
    }, delay)
  }

  async #reconnect(): Promise<void> {
    if (this.#disposed || this.#givenUp || this.#opts.isDisposed()) return
    this.#running = true
    try {
      const ok = await this.#opts.validate()
      if (!ok || this.#disposed || this.#givenUp || this.#opts.isDisposed()) {
        if (!ok) this.#giveUp("missing")
        return
      }
      if (this.#connectedAt !== undefined) {
        // A socket came up while validating (stale timer raced a live
        // connection); a live connection supersedes the queued retry.
        this.#closeWhileRunning = false
        return
      }
      this.#opts.connect()
    } catch {
      this.#giveUp("exhausted")
    } finally {
      this.#running = false
      if (this.#closeWhileRunning) {
        this.#closeWhileRunning = false
        if (!this.#disposed && !this.#givenUp && !this.#opts.isDisposed()) {
          this.#schedule()
        }
      }
    }
  }

  #giveUp(reason: GiveUpReason): void {
    if (this.#givenUp) return
    this.#givenUp = true
    if (this.#timerId !== undefined) {
      this.#opts.timer.clearTimeout(this.#timerId)
      this.#timerId = undefined
    }
    this.#opts.onGiveUp(reason)
  }
}
