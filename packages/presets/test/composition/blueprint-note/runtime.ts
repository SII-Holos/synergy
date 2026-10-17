import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerNote } from "@ericsanchezok/synergy-note/register"
import { registerBlueprintNoteKind } from "@ericsanchezok/synergy-blueprint/note-kind"

export function testRuntime(options: { home?: string; register?: () => void } = {}) {
  return harnessRuntime({
    home: options.home,
    composition: {
      register() {
        registerLocalRuntime()
        registerNote()
        registerBlueprintNoteKind()
        options.register?.()
      },
    },
  })
}
