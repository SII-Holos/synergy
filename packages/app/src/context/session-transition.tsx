import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type {
  SessionTransitionActions,
  SessionTransitionProgress,
} from "@/components/session/session-transition-progress"
import type { NewSessionRecovery } from "@/components/session/new-session-recovery"

export type SessionTransitionEntry = {
  progress: SessionTransitionProgress
  actions?: SessionTransitionActions
}

type StoredSessionTransitionEntry = SessionTransitionEntry & {
  revision: number
}

export function createSessionTransitionState() {
  const [entries, setEntries] = createStore<Record<string, StoredSessionTransitionEntry>>({})
  const recoveries = new Map<string, NewSessionRecovery>()
  let revision = 0

  const clear = (sessionID: string) => {
    setEntries(
      produce((draft) => {
        delete draft[sessionID]
      }),
    )
  }

  const set = (sessionID: string, progress: SessionTransitionProgress, actions?: SessionTransitionActions) => {
    const currentRevision = ++revision
    const guard = (action: (() => void) | undefined) =>
      action
        ? () => {
            if (entries[sessionID]?.revision !== currentRevision) return
            action()
          }
        : undefined
    const guardedActions =
      actions?.retry || actions?.dismiss
        ? {
            retry: guard(actions.retry),
            dismiss: guard(actions.dismiss),
          }
        : undefined

    setEntries(sessionID, {
      progress,
      actions: guardedActions,
      revision: currentRevision,
    })
  }

  const clearRecovery = (scopeKey: string) => {
    recoveries.delete(scopeKey)
  }

  const setRecovery = (scopeKey: string, recovery: NewSessionRecovery) => {
    recoveries.set(scopeKey, recovery)
  }

  return {
    get: (sessionID: string): SessionTransitionEntry | undefined => entries[sessionID],
    set,
    clear,
    getRecovery: (scopeKey: string) => recoveries.get(scopeKey),
    setRecovery,
    clearRecovery,
  }
}

const SessionTransitionContext = createContext<ReturnType<typeof createSessionTransitionState>>()

export function SessionTransitionProvider(props: ParentProps) {
  const value = createSessionTransitionState()
  return <SessionTransitionContext.Provider value={value}>{props.children}</SessionTransitionContext.Provider>
}

export function useSessionTransition() {
  const context = useContext(SessionTransitionContext)
  if (!context) throw new Error("useSessionTransition must be used within SessionTransitionProvider")
  return context
}
