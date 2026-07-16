import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type {
  SessionTransitionActions,
  SessionTransitionProgress,
} from "@/components/session/session-transition-progress"

export type SessionTransitionEntry = {
  progress: SessionTransitionProgress
  actions?: SessionTransitionActions
}

type StoredSessionTransitionEntry = SessionTransitionEntry & {
  revision: number
}

export function createSessionTransitionState() {
  const [entries, setEntries] = createStore<Record<string, StoredSessionTransitionEntry>>({})
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
    const guardedActions =
      actions?.retry || actions?.dismiss
        ? {
            retry: actions.retry,
            dismiss: actions.dismiss
              ? () => {
                  if (entries[sessionID]?.revision !== currentRevision) return
                  actions.dismiss?.()
                }
              : undefined,
          }
        : undefined

    setEntries(sessionID, {
      progress,
      actions: guardedActions,
      revision: currentRevision,
    })
  }

  return {
    get: (sessionID: string): SessionTransitionEntry | undefined => entries[sessionID],
    set,
    clear,
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
