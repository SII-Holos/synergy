import { createMemo, Show, type Component, type JSX } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { AP } from "@/app-i18n"
import { dialog } from "@/locales/messages"
import { SettingsDialog } from "@/components/settings"
import { ModelSelectionList } from "@/components/provider/model-manager"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useProviders } from "@/hooks/use-providers"
import { ModelUnavailableNotice } from "@/components/provider/model-unavailable-notice"
import "./dialog-select-model.css"

function useUnavailableModel() {
  const providers = useProviders()
  const { _ } = useLingui()
  const unavailable = createMemo(() => {
    const state = providers.readiness()
    return state?.state === "ready" ? undefined : state
  })
  const label = createMemo(() => {
    const state = unavailable()?.state
    if (state === "not-configured") return _(AP.appModelConfigure)
    if (state === "needs-attention") return _(AP.appModelCheckConnection)
    if (state === "restricted") return _(AP.appModelUnavailable)
    return _(dialog.selectModel)
  })
  return { unavailable, label }
}

export const ModelSelectorPopover: Component<{
  provider?: string
  triggerAs: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>>
  placement?: "top-start" | "bottom-start"
}> = (props) => {
  const dialogContext = useDialog()
  const { _ } = useLingui()
  const { unavailable, label } = useUnavailableModel()

  return (
    <ToolbarSelectorPopover
      triggerAs={(triggerProps) => (
        <props.triggerAs
          {...triggerProps}
          aria-label={unavailable() ? label() : undefined}
          children={
            unavailable() ? (
              <>
                <Icon name={getSemanticIcon("state.warning")} size="small" class="text-icon-warning-base shrink-0" />
                <span class="truncate">{label()}</span>
              </>
            ) : undefined
          }
        />
      )}
      title={label()}
      placement={props.placement}
      contentClass={unavailable() ? "model-selector-popover model-selector-recovery" : "model-selector-popover"}
    >
      {(close) => (
        <Show
          when={unavailable()}
          fallback={
            <div class="model-selector-content flex min-h-0 flex-col p-1">
              <ModelSelectionList provider={props.provider} onSelect={close} />
              <div class="model-selector-footer shrink-0 px-2 pb-2 pt-1 flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  class="model-selector-popover-footer-action h-7 px-2.5 text-12-medium text-text-base"
                  onClick={() => {
                    close()
                    dialogContext.show(() => <SettingsDialog initialTab="models" />)
                  }}
                >
                  {_(dialog.modelSettings)}
                </Button>
                <Button
                  variant="ghost"
                  class="model-selector-popover-footer-action h-7 px-2.5 text-12-medium text-text-weak"
                  onClick={() => {
                    close()
                    dialogContext.show(() => <SettingsDialog initialTab="providers" />)
                  }}
                >
                  {_(dialog.connectProvider)}
                </Button>
              </div>
            </div>
          }
        >
          {(state) => <ModelUnavailableNotice state={state()} onConfigure={close} />}
        </Show>
      )}
    </ToolbarSelectorPopover>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialogContext = useDialog()
  const { _ } = useLingui()
  const { unavailable, label } = useUnavailableModel()

  return (
    <Dialog
      title={label()}
      description={unavailable() ? undefined : _(dialog.selectModelDesc)}
      size="list"
      action={
        <Show when={!unavailable()}>
          <Button
            class="h-7 -my-1 text-14-medium"
            icon={getSemanticIcon("settings.models")}
            tabIndex={-1}
            onClick={() => {
              dialogContext.show(() => <SettingsDialog initialTab="models" />)
            }}
          >
            {_(dialog.modelSettings)}
          </Button>
        </Show>
      }
    >
      <Show
        when={unavailable()}
        fallback={
          <div class="flex h-96 min-h-0 flex-col p-1">
            <ModelSelectionList provider={props.provider} onSelect={() => dialogContext.close()} />
          </div>
        }
      >
        {(state) => <ModelUnavailableNotice state={state()} />}
      </Show>
    </Dialog>
  )
}
