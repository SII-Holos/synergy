export class BusyError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Session ${sessionID} is busy`)
  }
}

/**
 * The abort reason for a stop that *pauses* a session instead of failing it.
 *
 * A user stop and a graceful shutdown leave the interrupted turn resumable, so
 * the turn's terminal record (`finish:"error"` plus `time.completed`) belongs to
 * the Abandon path alone. The intent therefore travels *on the abort itself*,
 * which makes it atomic with the stop: every writer that terminalizes an
 * interrupted turn observes it as part of the abort it is already reacting to,
 * instead of racing a separate flag written by a concurrent repair.
 *
 * `name` stays `AbortError` so every existing abort classification — network
 * error mapping, retry suppression, tool settlement — behaves exactly as it
 * does for any other abort.
 */
export class PausedTurnAbort extends DOMException {
  constructor() {
    super("Turn stopped; the session is paused and awaiting an explicit continue", "AbortError")
  }

  static is(reason: unknown): reason is PausedTurnAbort {
    return reason instanceof PausedTurnAbort
  }
}
