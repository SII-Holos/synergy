import { onCleanup } from "solid-js"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { claimCompletion, composerMounted, saveSuggestion, type DigitalTwinOwner } from "./presence"

/**
 * Automatic prediction has to outlive the composer: when a turn finishes in a
 * Session the user has navigated away from, nothing is mounted to notice it.
 * This predictor covers exactly those Sessions and stays silent, because the
 * user never asked for this suggestion.
 */
export function DigitalTwinBackground() {
  const sdk = useSDK()
  const sync = useSync()
  const globalSDK = useGlobalSDK()
  const inflight = new Set<AbortController>()

  const predict = async (sessionID: string, anchor: { rootID: string; assistantID: string }) => {
    if (sync.data.config.digitalTwin?.automatic !== true) return
    if (!sdk.capabilities.has("digital-twin")) return
    const owner: DigitalTwinOwner = { url: sdk.url, scopeKey: sdk.scopeKey, sessionID }
    if (composerMounted(owner)) return
    const session = sync.data.session.find((value) => value.id === sessionID)
    if (!session || session.parentID) return
    if (globalSDK.drafts.hasDraftSession(sessionID)) return
    if (!claimCompletion(sessionID, anchor.rootID, anchor.assistantID)) return
    const controller = new AbortController()
    inflight.add(controller)
    try {
      const response = await sdk.client.digitalTwin.predictNextInput(
        { digitalTwinInput: { sessionID, requestID: generateUUID(), expected: anchor } },
        { signal: controller.signal, throwOnError: true },
      )
      if (controller.signal.aborted) return
      const result = response.data!
      saveSuggestion(owner, {
        rootID: result.stamp.rootID,
        assistantID: result.stamp.assistantID,
        proposalID: result.proposalID,
        text: result.candidate,
      })
    } catch {
      // Nobody asked for this suggestion, so it reports no failure either.
    } finally {
      inflight.delete(controller)
    }
  }

  const event = sdk.event.on("session.root.completed", ({ properties }) => {
    void predict(properties.sessionID, { rootID: properties.rootID, assistantID: properties.assistantID })
  })
  onCleanup(() => {
    event()
    for (const controller of inflight) controller.abort()
    inflight.clear()
  })
  return null
}
