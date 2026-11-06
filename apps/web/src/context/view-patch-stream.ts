import { applyProjectionPatch, ProjectionPatch } from "@ericsanchezok/synergy-util/projection-patch"

type Frame = {
  kind: string
  sessionID: string
  generation: number
  revision: number
  previousRevision: number
  patches: Array<{ path: string[]; value?: unknown; remove?: true }>
  snapshot?: string
}
export function createViewPatchStream(input: {
  accepts(scopeID: string, frame: Frame): boolean
  read(scopeID: string, frame: Frame, signal: AbortSignal): Promise<unknown>
  emit(scopeID: string, value: unknown, frame: Frame): void
  recover(scopeID: string, frame: Frame): void
}) {
  type State = {
    controller: AbortController
    generation: number
    revision: number
    value: unknown
    pending: Promise<void>
    queued: number
  }
  const entries = new Map<string, State>()
  let disposed = false
  return {
    receive(scopeID: string, frame: Frame) {
      if (disposed || !input.accepts(scopeID, frame)) return Promise.resolve()
      const key = JSON.stringify([scopeID, frame.kind, frame.sessionID])
      let state = entries.get(key)
      if (!state || state.generation !== frame.generation) {
        state?.controller.abort()
        state = {
          controller: new AbortController(),
          generation: frame.generation,
          revision: 0,
          value: undefined,
          pending: Promise.resolve(),
          queued: 0,
        }
        entries.set(key, state)
      }
      const current = state
      const valid = () =>
        !disposed && !current.controller.signal.aborted && entries.get(key) === current && input.accepts(scopeID, frame)
      const recover = () => {
        if (!valid()) return
        current.controller.abort()
        entries.delete(key)
        input.recover(scopeID, frame)
      }
      if (++current.queued > 64) {
        recover()
        return Promise.resolve()
      }
      current.pending = current.pending
        .then(async () => {
          if (!valid()) return
          if (frame.previousRevision !== current.revision || frame.revision !== current.revision + 1) {
            recover()
            return
          }
          const value = frame.snapshot
            ? await input.read(scopeID, frame, current.controller.signal)
            : applyProjectionPatch(current.value, ProjectionPatch.array().parse(frame.patches))
          if (!valid()) return
          current.value = value
          current.revision = frame.revision
          input.emit(scopeID, value, frame)
        })
        .catch(recover)
        .finally(() => {
          current.queued--
        })
      return current.pending
    },
    prune() {
      for (const [key, value] of entries) {
        const [scopeID, kind, sessionID] = JSON.parse(key) as string[]
        if (
          input.accepts(scopeID, {
            kind,
            sessionID,
            generation: value.generation,
            revision: value.revision,
            previousRevision: value.revision,
            patches: [],
          })
        )
          continue
        value.controller.abort()
        entries.delete(key)
      }
    },
    dispose() {
      disposed = true
      for (const entry of entries.values()) entry.controller.abort()
      entries.clear()
    },
  }
}
