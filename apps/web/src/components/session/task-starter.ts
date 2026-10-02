import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { ComposerDocumentError } from "../prompt-input/composer-document"

type StarterInput = Pick<PluginInputService, "current" | "applyEdits" | "select">

export function prepareTaskStarter(input: StarterInput, current: () => StarterInput | undefined, text: string) {
  const snapshot = input.current()
  return {
    requiresConfirmation: snapshot.text.length > 0,
    async apply() {
      if (current() !== input || input.current().sessionId !== snapshot.sessionId) return false
      try {
        await input.applyEdits({
          revision: snapshot.revision,
          edits: [{ range: { start: 0, end: snapshot.text.length }, text }],
        })
        input.select({ start: text.length, end: text.length })
        return true
      } catch (error) {
        if (error instanceof ComposerDocumentError && error.code === "stale_revision") return false
        throw error
      }
    },
  }
}
