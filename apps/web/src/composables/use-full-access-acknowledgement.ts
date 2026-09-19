import { useConfirm } from "@/components/dialog/confirm-dialog"
import { fullAccessConfirm } from "@/components/dialog/full-access-confirm"
import { needsFullAccessAcknowledgement } from "@/components/dialog/full-access-ack-model"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"

/**
 * One-time acknowledgement for enabling Full Access from the UI.
 *
 * This is an awareness gate, not a security boundary: it records that the human
 * accepted the risk and stops re-asking. Programmatic session creation never
 * consults it, and editing config by hand is unaffected.
 */
export function useFullAccessAcknowledgement() {
  const confirm = useConfirm()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()

  function acknowledged(): boolean {
    return globalSync.data.config.fullAccessAcknowledged === true
  }

  async function record() {
    await globalSDK.client.config.domain.update({
      domain: "permissions",
      configDomainUpdateInput: { config: { fullAccessAcknowledged: true } as never },
    })
  }

  /**
   * Resolves true when the caller may proceed with Full Access. Returns false
   * only when the human dismissed the warning.
   */
  async function ensure(targetProfile: string | undefined, currentProfile?: string): Promise<boolean> {
    if (!needsFullAccessAcknowledgement({ targetProfile, currentProfile, acknowledged: acknowledged() })) return true

    const copy = fullAccessConfirm()
    const accepted = await confirm.ask({
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      cancelLabel: copy.cancelLabel,
      tone: copy.tone,
    })
    if (!accepted) return false

    try {
      await record()
    } catch (error) {
      // The transition is still what the human asked for; a failed bookkeeping
      // write must not silently invert their choice. It only means the warning
      // reappears next time.
      console.error("Failed to record the Full Access acknowledgement", error)
    }
    return true
  }

  return { ensure, acknowledged }
}
