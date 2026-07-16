import { Button } from "@ericsanchezok/synergy-ui/button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Show, onMount } from "solid-js"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { PersonalizeController } from "./personalize-controller"

export function PersonalizePanel(props: { controller: PersonalizeController }) {
  const confirm = useConfirm()
  const controller = props.controller

  onMount(() => {
    if (!controller.info() && controller.status() === "idle") void controller.load()
  })

  async function save() {
    const saved = await controller.save()
    if (!saved) {
      showToast({
        type: "error",
        title: "Custom instructions not saved",
        description: controller.error() ?? "Review the Custom Instructions content and try again.",
      })
      return
    }
    showToast({
      type: "success",
      title: controller.info()?.hasOverride ? "Custom instructions saved" : "Custom instructions reset",
      description: controller.info()?.hasOverride
        ? "Synergy will use AGENTS.override.md for subsequent prompt assembly."
        : "Synergy will fall back to the global AGENTS.md file.",
    })
  }

  function reset() {
    confirm.show({
      title: "Reset custom instructions?",
      description: "Remove AGENTS.override.md and return to the global AGENTS.md content.",
      confirmLabel: "Reset to AGENTS.md",
      cancelLabel: "Keep override",
      tone: "warning",
      onConfirm: async () => {
        const reset = await controller.reset()
        if (!reset) {
          showToast({
            type: "error",
            title: "Custom instructions not reset",
            description: controller.error() ?? "Try again.",
          })
          return
        }
        showToast({
          type: "success",
          title: "Custom instructions reset",
          description: "Synergy will use the global AGENTS.md file for subsequent prompt assembly.",
        })
      },
    })
  }

  return (
    <SettingsPage
      title="Personalize"
      description="Set global instructions that shape how Synergy works with you across projects."
    >
      <SettingsSection
        title="Custom Instructions"
        description="These instructions join Synergy's existing instruction chain. Project AGENTS.md files remain separate and can add more specific guidance."
      >
        <Show
          when={controller.info()}
          fallback={
            <div class="personalize-loading-state" role="status">
              <Show when={controller.status() === "loading"} fallback={<span>{controller.error()}</span>}>
                <Spinner />
                <span>Loading global instructions...</span>
              </Show>
              <Show when={controller.status() === "error"}>
                <Button type="button" variant="secondary" size="small" onClick={() => void controller.load()}>
                  Retry
                </Button>
              </Show>
            </div>
          }
        >
          <div class="personalize-editor">
            <div class="personalize-source-row">
              <div>
                <div class="personalize-source-title">
                  {controller.info()?.hasOverride ? "Managed override" : "Global instructions"}
                </div>
                <div class="personalize-source-description">
                  <Show
                    when={controller.info()?.sourceFilename}
                    fallback="No global instructions file exists yet. Saving creates AGENTS.override.md."
                  >
                    Showing {controller.info()?.sourceFilename}. Saving always writes AGENTS.override.md and preserves
                    AGENTS.md.
                  </Show>
                </div>
              </div>
              <Show when={controller.info()?.hasOverride}>
                <Button type="button" variant="ghost" size="small" disabled={controller.busy()} onClick={reset}>
                  Reset to AGENTS.md
                </Button>
              </Show>
            </div>

            <TextField
              label="Custom instructions"
              hideLabel
              multiline
              class="personalize-instructions-input"
              value={controller.content()}
              disabled={controller.busy()}
              validationState={controller.overLimit() ? "invalid" : "valid"}
              error={
                controller.overLimit()
                  ? `Custom instructions cannot exceed ${controller.info()?.maxBytes} bytes.`
                  : undefined
              }
              onChange={controller.setContent}
              placeholder="Describe your preferred language, response style, engineering conventions, or collaboration rules."
            />

            <div class="personalize-editor-footer">
              <div
                class="personalize-byte-count"
                classList={{ "personalize-byte-count-error": controller.overLimit() }}
              >
                {controller.byteCount().toLocaleString()} / {controller.info()?.maxBytes.toLocaleString()} bytes
              </div>
              <div class="personalize-actions">
                <Show when={controller.status() === "error"}>
                  <span class="personalize-error" role="alert">
                    {controller.error()}
                  </span>
                </Show>
                <Button
                  type="button"
                  variant="primary"
                  size="normal"
                  disabled={!controller.canSave()}
                  onClick={() => void save()}
                >
                  {controller.status() === "saving" ? "Saving..." : "Save Custom Instructions"}
                </Button>
              </div>
            </div>
          </div>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
