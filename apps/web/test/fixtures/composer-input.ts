import type { PluginInputService } from "@ericsanchezok/synergy-plugin"

export function createComposerFixtureInput(
  props: Pick<PluginInputService, "editor" | "current" | "render">,
): PluginInputService {
  const input: PluginInputService = {
    ...props,
    readOnly: () => false,
    composing: () => false,
    primaryAction: () => "submit",
    ready: () => true,
    canSubmit: () => true,
    submitting: () => false,
    stopping: () => false,
    dragging: () => false,
    className: () => undefined,
    async applyEdits() {
      return input.current()
    },
    select() {},
    setComposing() {},
    setMode() {},
    async submit() {},
    async stop() {},
    attachments: () => [],
    async addAttachments() {},
    removeAttachment() {},
    agents: () => [],
    agent: () => undefined,
    selectAgent() {},
    models: () => [],
    model: () => undefined,
    selectModel() {},
    variants: () => [],
    variant: () => undefined,
    selectVariant() {},
    dragOver() {},
    dragLeave() {},
    async drop() {},
  }
  return input
}
