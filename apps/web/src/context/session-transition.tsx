import { batch, createContext, useContext, type ParentProps } from "solid-js"
import type { Prompt } from "@/context/prompt"
import { createSessionPreparationProgress } from "@/components/session/session-transition-progress"
import { createStore, produce, reconcile } from "solid-js/store"
import type {
  SessionTransitionActions,
  SessionTransitionProgress,
} from "@/components/session/session-transition-progress"
import type { SessionTransitionHandoff } from "@/components/session/session-transition-handoff"
import type { NewSessionRecovery } from "@/components/session/new-session-recovery"

export type SessionTransitionEntry = {
  progress: SessionTransitionProgress
  actions?: SessionTransitionActions
  handoff?: SessionTransitionHandoff
  draft?: { intent: number; text?: string; messageID?: string; prompt?: Prompt }
}

export function draftTransitionKey(server: string, scope: string) {
  return `draft:${JSON.stringify([server, scope])}`
}

type StoredSessionTransitionEntry = SessionTransitionEntry & {
  revision: number
}

export function createSessionTransitionState() {
  const [entries, setEntries] = createStore<Record<string, StoredSessionTransitionEntry>>({})
  const [recoveries, setRecoveries] = createStore<Record<string, NewSessionRecovery>>({})
  const dismissedHandoffs = new Map<string, string>()
  let revision = 0

  const clear = (sessionID: string) => {
    setEntries(
      produce((draft) => {
        delete draft[sessionID]
      }),
    )
  }

  const dismissHandoff = (sessionID: string, messageID: string) => {
    dismissedHandoffs.set(sessionID, messageID)
    clear(sessionID)
  }

  const isHandoffDismissed = (sessionID: string, messageID: string) => dismissedHandoffs.get(sessionID) === messageID

  const set = (
    sessionID: string,
    progress: SessionTransitionProgress,
    actions?: SessionTransitionActions,
    handoff?: SessionTransitionHandoff,
  ) => {
    if (progress.phase === "success") {
      clear(sessionID)
      return
    }
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
      handoff,
      revision: currentRevision,
      draft: entries[sessionID]?.draft,
    })
  }

  const confirmHandoff = (sessionID: string, messageID: string) => {
    const handoff = entries[sessionID]?.handoff
    if (handoff?.messageID !== messageID || !handoff.unconfirmed) return false
    const accepted = handoff.unconfirmed.accepted
    setEntries(sessionID, "handoff", "unconfirmed", undefined)
    accepted()
    return true
  }

  const completeHandoff = (sessionID: string, messageID: string) => {
    const handoff = entries[sessionID]?.handoff
    if (handoff?.messageID !== messageID) return false
    confirmHandoff(sessionID, messageID)
    dismissHandoff(sessionID, messageID)
    return true
  }

  const clearRecovery = (scopeKey: string) => {
    setRecoveries(
      produce((draft) => {
        delete draft[scopeKey]
      }),
    )
  }

  const setRecovery = (scopeKey: string, recovery: NewSessionRecovery) => {
    setRecoveries(scopeKey, reconcile(recovery))
  }

  return {
    prepareDraft(key: string) {
      set(key, createSessionPreparationProgress())
      const intent = revision
      setEntries(key, "draft", { intent })
      const current = () => entries[key]?.draft?.intent === intent
      return {
        setText(text: string) {
          if (current()) setEntries(key, "draft", "text", text)
        },
        submit(draft: { text: string; messageID: string; prompt: Prompt }) {
          if (!current()) return false
          setEntries(key, "draft", { intent, ...draft })
          return true
        },
        progress(progress: SessionTransitionProgress, actions?: SessionTransitionActions) {
          if (!current()) return false
          set(key, progress, actions)
          return true
        },
        handoff(sessionID: string, progress: SessionTransitionProgress) {
          if (!current()) return false
          const draft = entries[key].draft
          batch(() => {
            set(sessionID, progress)
            setEntries(sessionID, "draft", draft)
            clear(key)
          })
          return true
        },
        clear() {
          if (current()) clear(key)
        },
      }
    },
    get: (sessionID: string): SessionTransitionEntry | undefined => entries[sessionID],
    set,
    clear,
    dismissHandoff,
    completeHandoff,
    confirmHandoff,
    isHandoffDismissed,
    getRecovery: (scopeKey: string) => recoveries[scopeKey],
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
