import type { Message, Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { computeLatestStatusFromParts } from "@ericsanchezok/synergy-ui/session-status"

export function computePromptRawStatus(params: {
  assistantMessages: readonly Message[]
  getParts: (messageID: string) => readonly Part[]
}): string | undefined {
  const latestAssistant = params.assistantMessages.at(-1)
  if (!latestAssistant) return undefined
  return computeLatestStatusFromParts(params.getParts(latestAssistant.id))
}

export function computePromptWorkingSummary(params: {
  status: SessionStatus
  working: boolean
  rawStatus?: string
  fallbackWorkingPhrase?: string
}): string | undefined {
  if (!params.working) return undefined
  return (
    params.rawStatus ??
    (params.status.type === "busy" ? params.status.description : undefined) ??
    params.fallbackWorkingPhrase
  )
}

export function createStatusBurstGate(minIntervalMs = 2500) {
  let lastStatusChange = Date.now()
  let pendingText: string | undefined
  let pendingTimer: number | undefined
  let visibleText: string | undefined

  const clearPending = () => {
    if (pendingTimer) {
      window.clearTimeout(pendingTimer)
      pendingTimer = undefined
    }
    pendingText = undefined
  }

  return {
    reset() {
      clearPending()
      visibleText = undefined
      lastStatusChange = Date.now()
    },
    next(text: string | undefined, push: (text: string) => void) {
      if (!text || text === visibleText) return
      const elapsed = Date.now() - lastStatusChange
      if (elapsed >= minIntervalMs) {
        clearPending()
        visibleText = text
        lastStatusChange = Date.now()
        push(text)
        return
      }

      pendingText = text
      if (pendingTimer) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(() => {
        if (!pendingText || pendingText === visibleText) return
        visibleText = pendingText
        lastStatusChange = Date.now()
        push(pendingText)
        clearPending()
      }, minIntervalMs - elapsed)
    },
  }
}
