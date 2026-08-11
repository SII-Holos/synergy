import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Show, onMount } from "solid-js"
import { useLocale } from "@/context/locale"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { PersonalizeController } from "./personalize-controller"

const confirmResetTitle = { id: "settings.personalize.confirmReset.title", message: "Reset custom instructions?" }
const confirmResetDesc = {
  id: "settings.personalize.confirmReset.description",
  message: "Clear this draft and stage removal of AGENTS.override.md. Save Changes commits the reset.",
}
const confirmResetConfirmLabel = {
  id: "settings.personalize.confirmReset.confirm",
  message: "Stage reset to AGENTS.md",
}
const confirmResetCancelLabel = { id: "settings.personalize.confirmReset.cancel", message: "Keep override" }
const managedOverrideTitle = { id: "settings.personalize.managedOverride", message: "Managed override" }
const globalInstructionsTitle = { id: "settings.personalize.globalInstructions", message: "Global instructions" }
const noGlobalFile = {
  id: "settings.personalize.noGlobalFile",
  message: "No global instructions file exists yet. Saving creates AGENTS.override.md.",
}
const retryLabel = { id: "settings.personalize.retry", message: "Retry" }
const loadingLabel = { id: "settings.personalize.loading", message: "Loading global instructions..." }

const pageTitle = { id: "settings.personalize.page.title", message: "Personalize" }
const pageDescription = {
  id: "settings.personalize.page.description",
  message: "Set global instructions that shape how Synergy works with you across projects.",
}
const sectionTitle = { id: "settings.personalize.section.title", message: "Custom Instructions" }
const sectionDescription = {
  id: "settings.personalize.section.description",
  message:
    "These instructions join Synergy's existing instruction chain. Project AGENTS.md files remain separate and can add more specific guidance.",
}
const showingSource = {
  id: "settings.personalize.showingSource",
  message: "Showing {filename}. Saving always writes AGENTS.override.md and preserves AGENTS.md.",
}
const byteLimitError = {
  id: "settings.personalize.byteLimit",
  message: "Custom instructions cannot exceed {maxBytes} bytes.",
}
const inputPlaceholder = {
  id: "settings.personalize.input.placeholder",
  message: "Describe your preferred language, response style, engineering conventions, or collaboration rules.",
}
const bytesLabel = { id: "settings.personalize.bytes", message: "bytes" }

export function PersonalizePanel(props: { controller: PersonalizeController }) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const confirm = useConfirm()
  const controller = props.controller

  onMount(() => {
    if (!controller.info() && controller.status() === "idle") void controller.load()
  })

  function reset() {
    confirm.show({
      title: confirmResetTitle,
      description: confirmResetDesc,
      confirmLabel: confirmResetConfirmLabel,
      cancelLabel: confirmResetCancelLabel,
      tone: "warning",
      onConfirm: () => {
        controller.stageReset()
      },
    })
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(sectionTitle)} description={_(sectionDescription)}>
        <Show
          when={controller.info()}
          fallback={
            <div class="personalize-loading-state" role="status">
              <Show when={controller.status() === "loading"} fallback={<span>{controller.error()}</span>}>
                <Spinner />
                <span>{_(loadingLabel)}</span>
              </Show>
              <Show when={controller.status() === "error"}>
                <Button type="button" variant="secondary" size="small" onClick={() => void controller.load()}>
                  {_(retryLabel)}
                </Button>
              </Show>
            </div>
          }
        >
          <div class="personalize-editor">
            <div class="personalize-source-row">
              <div>
                <div class="personalize-source-title">
                  {controller.info()?.hasOverride ? _(managedOverrideTitle) : _(globalInstructionsTitle)}
                </div>
                <div class="personalize-source-description">
                  <Show when={controller.info()?.sourceFilename} fallback={_(noGlobalFile)}>
                    {_({ ...showingSource, values: { filename: controller.info()?.sourceFilename ?? "" } })}
                  </Show>
                </div>
              </div>
              <Show when={controller.info()?.hasOverride}>
                <Button type="button" variant="ghost" size="small" disabled={controller.busy()} onClick={reset}>
                  {_(confirmResetConfirmLabel)}
                </Button>
              </Show>
            </div>

            <TextField
              label={_(sectionTitle)}
              hideLabel
              multiline
              class="personalize-instructions-input"
              value={controller.content()}
              disabled={controller.busy()}
              validationState={controller.overLimit() ? "invalid" : "valid"}
              error={
                controller.overLimit()
                  ? _({ ...byteLimitError, values: { maxBytes: String(controller.info()?.maxBytes ?? 0) } })
                  : undefined
              }
              onChange={controller.setContent}
              placeholder={_(inputPlaceholder)}
            />

            <div class="personalize-editor-footer">
              <div
                class="personalize-byte-count"
                classList={{ "personalize-byte-count-error": controller.overLimit() }}
              >
                {fmt.number(controller.byteCount())} / {fmt.number(controller.info()?.maxBytes ?? 0)} {_(bytesLabel)}
              </div>
              <div class="personalize-actions">
                <Show when={controller.status() === "error"}>
                  <span class="personalize-error" role="alert">
                    {controller.error()}
                  </span>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
